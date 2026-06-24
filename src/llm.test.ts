import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { analyzeSignal, callLlmSync, callLlmStream, callLlmStreamWithTools, callLlmStreamWithPhases, callLlmWithTools, LlmConfig, getLlmConfig, LlmStreamOptions } from './llm';
import { createTestDb, seedChannel, seedSignal } from '../tests/fixtures/test-db';

const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
});

function mockMergedResponse(json: Record<string, unknown>) {
  // Streaming path: analyzeSignal now uses callLlmStreamWithPhases which needs SSE body
  const encoder = new TextEncoder();
  const sseLines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(json) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];

  const readable = new ReadableStream({
    start(controller) {
      for (const line of sseLines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);
}

const config: LlmConfig = {
  endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'qwen/qwen3.6-27b',
};

describe('llm', () => {
  describe('callLlmSync', () => {
    it('returns full content string from LLM via sync request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'Hello world' } }] }),
      } as any);

      const result = await callLlmSync(config, 'test prompt');

      expect(result).toBe('Hello world');
      expect(mockFetch).toHaveBeenCalledWith(config.endpoint, expect.any(Object));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe(config.model);
      expect(body.messages).toEqual([{ role: 'user', content: 'test prompt' }]);
      expect(body.stream).toBeFalsy();
    });

    it('throws on HTTP error response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

      await expect(callLlmSync(config, 'prompt')).rejects.toThrow('LLM sync HTTP 500 Internal Server Error');
    });

    it('throws on unexpected response structure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [] }) } as any);

      await expect(callLlmSync(config, 'prompt')).rejects.toThrow('unexpected response structure');
    });

    it('supports abortSignal for cancellation', async () => {
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockImplementation(() => {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      });

      await expect(callLlmSync(config, 'prompt', { abortSignal: controller.signal }))
        .rejects.toThrow(/timed out|abort/i);
    });
  });

  describe('callLlmStream', () => {
    function mockSseResponse(chunks: string[]) {
      const encoder = new TextEncoder();
      let index = 0;

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
            index++;
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: readable,
      } as any);
    }

    it('yields token chunks via streaming', async () => {
      mockSseResponse([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

      const chunks = [];
      for await (const token of callLlmStream(config, 'test prompt')) {
        chunks.push(token);
      }

      expect(chunks).toEqual(['Hello ', 'world']);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.stream).toBe(true);
    });

    it('throws on HTTP error response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' } as any);

      const gen = callLlmStream(config, 'prompt');
      let error;
      try {
        await gen.next();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect((error as Error).message).toContain('HTTP 503');
    });

    it('supports abortSignal for cancellation', async () => {
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockImplementation(() => {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      });

      const gen = callLlmStream(config, 'prompt', { abortSignal: controller.signal });
      let error;
      try {
        await gen.next();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect((error as Error).message.toLowerCase()).toMatch(/abort/i);
    });
  });

  describe('getLlmConfig', () => {
    it('reads LLM_ENDPOINT and LLM_MODEL from process.env', () => {
      const origE = process.env.LLM_ENDPOINT;
      const origM = process.env.LLM_MODEL;
      process.env.LLM_ENDPOINT = 'http://custom:9999/v1/chat/completions';
      process.env.LLM_MODEL = 'custom/model';

      expect(getLlmConfig()).toEqual({ endpoint: 'http://custom:9999/v1/chat/completions', model: 'custom/model' });

      process.env.LLM_ENDPOINT = origE;
      process.env.LLM_MODEL = origM;
    });

    it('returns defaults when env vars are unset', () => {
      const origE = process.env.LLM_ENDPOINT;
      const origM = process.env.LLM_MODEL;
      delete process.env.LLM_ENDPOINT;
      delete process.env.LLM_MODEL;

      expect(getLlmConfig()).toEqual({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' });

      if (origE !== undefined) process.env.LLM_ENDPOINT = origE;
      if (origM !== undefined) process.env.LLM_MODEL = origM;
    });
  });

  describe('analyzeSignal', () => {
    it('makes one LLM call, persists summary/sentiment/entities to db', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v1', 'this is a test video about mtg');

      mockMergedResponse({
        summary: 'Video discusses MTG topics',
        takeaways: [{ text: 'Intro about MTG', timestamp: 'T:0' }, { text: 'Card review segment', timestamp: 'T:10' }],
        overall_sentiment: { score: 4, label: 'Positive' },
        entities: [{ entity_name: 'Kaldra', entity_type: 'set', sentiment: 'Positive' }],
      });

      const result = await analyzeSignal(db, 'v1', config);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify prompt contains analysis instructions
      const prompt = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages[0].content;
      expect(prompt).toContain('summary');
      expect(prompt).toContain('takeaways');
      expect(prompt).toContain('sentiment');
      expect(prompt).toContain('entity');

      // Verify db persisted all fields
      const sig = db.prepare('SELECT summary, overall_sentiment, sentiment_label FROM signals WHERE video_id = ?').get('v1') as { summary: string | null; overall_sentiment: number | null; sentiment_label: string | null } | undefined;
      expect(sig!.summary).toContain('Video discusses MTG topics');
      expect(sig!.overall_sentiment).toBe(4);
      expect(sig!.sentiment_label).toBe('Positive');

      const mentions = db.prepare('SELECT entity_name FROM entity_mentions WHERE signal_video_id = ?').all('v1') as Array<{ entity_name: string }>;
      expect(mentions).toHaveLength(1);
      expect(mentions[0].entity_name).toBe('Kaldra');
    });

    it('formats grouped transcription with [T:ss] timestamps', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      const transcription = JSON.stringify([
        { time: 0, text: 'hello world mtg news today' },
        { time: 10000, text: 'kaldra is great' },
      ]);
      seedSignal(db, 'v2', transcription);

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      await analyzeSignal(db, 'v2', config);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.messages[0].content).toContain('[T:0] hello world mtg news today');
      expect(body.messages[0].content).toContain('[T:10] kaldra is great');
    });

    it('clamps sentiment score to 1-5 range', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v3', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 10, label: 'Positive' }, entities: [] });

      await analyzeSignal(db, 'v3', config);

      const sig = db.prepare('SELECT overall_sentiment FROM signals WHERE video_id = ?').get('v3') as { overall_sentiment: number | null } | undefined;
      expect(sig!.overall_sentiment).toBe(5); // clamped to max
    });

    it('persists multiple entity mentions with correct types', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v4', 'transcription about cards');

      mockMergedResponse({
        summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [
          { entity_name: 'Lurrus', entity_type: 'creature', sentiment: 'Positive' },
          { entity_name: 'Dredge', entity_type: 'archetype', sentiment: 'Negative' },
          { entity_name: 'Modern', entity_type: 'format', sentiment: 'Neutral' },
        ],
      });

      await analyzeSignal(db, 'v4', config);

      const mentions = db.prepare('SELECT entity_name, entity_type, sentiment FROM entity_mentions WHERE signal_video_id = ? ORDER BY id').all('v4');
      expect(mentions).toHaveLength(3);
      expect(mentions[0]).toMatchObject({ entity_name: 'Lurrus', entity_type: 'creature', sentiment: 'Positive' });
    });

    it('returns failure when LLM HTTP call fails', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v5', 'text');

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any);

      const result = await analyzeSignal(db, 'v5', config);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const sig = db.prepare('SELECT summary, overall_sentiment FROM signals WHERE video_id = ?').get('v5') as { summary: string | null; overall_sentiment: number | null } | undefined;
      expect(sig!.summary).toBeNull();
    });

    it('returns failure when LLM returns malformed JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v6', 'text');

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'not json' } }] }) as any });

      const result = await analyzeSignal(db, 'v6', config);
      expect(result.success).toBe(false);
    });

    it('uses correct endpoint and model in fetch call', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v7', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      await analyzeSignal(db, 'v7', config);

      expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/chat/completions', expect.any(Object));
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('qwen/qwen3.6-27b');
    });

    it('injects channel topic filter_text into prompt', async () => {
      const db = createTestDb();
      db.prepare('INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)').run('modern', 'Modern', 'Only Modern format.');
      seedChannel(db, 'UCfilter', 1);
      db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('v-filter', 'UCfilter', 'Test', 'some text', Date.now());

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      await analyzeSignal(db, 'v-filter', config);

      const prompt = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages[0].content;
      expect(prompt).toContain('Only Modern format.');
    });

    it('relevant:false -> sets processing_state=irrelevant, skips summary/sentiment/entities', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-irrel', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [], relevant: false });

      const result = await analyzeSignal(db, 'v-irrel', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state, summary FROM signals WHERE video_id = ?').get('v-irrel') as { processing_state: string; summary: string | null } | undefined;
      expect(sig!.processing_state).toBe('irrelevant');
      expect(sig!.summary).toBeNull();
    });

    it('missing relevant field -> backward compat, treated as relevant', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-backcompat', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      const result = await analyzeSignal(db, 'v-backcompat', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-backcompat') as { processing_state: string } | undefined;
      expect(sig!.processing_state).toBe('summarized');
    });

    it('prompt instructs minimal JSON when irrelevant', async () => {
      const db = createTestDb();
      db.prepare('INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)').run('mtg', 'MTG', 'Must be about MTG.');
      seedChannel(db, 'UCfilter', 1);
      db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('v-minimal', 'UCfilter', 'Test', 'text', Date.now());

      mockMergedResponse({ relevant: false });

      await analyzeSignal(db, 'v-minimal', config);

      const prompt = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages[0].content;
      expect(prompt).toMatch(/if.*content.*not.*meet.*criteria.*return.*only|do not generate.*when relevant is false|relevant.*false.*return.*only/i);
    });

    it('accepts minimal { relevant: false } response', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-min-irr', 'text');

      mockMergedResponse({ relevant: false });

      const result = await analyzeSignal(db, 'v-min-irr', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state, summary FROM signals WHERE video_id = ?').get('v-min-irr') as { processing_state: string; summary: string | null } | undefined;
      expect(sig!.processing_state).toBe('irrelevant');
      expect(sig!.summary).toBeNull();
    });

    it('prompt includes CompactTranscription instruction', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-compact', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      await analyzeSignal(db, 'v-compact', config);

      const prompt = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages[0].content;
      expect(prompt).toMatch(/compact.*transcription|compact_text/i);
      expect(prompt).toMatch(/telegraphic|remove.*filler|remove.*function.*words/i);
    });

    it('persists compact_text from LLM response', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-compact-store', '[T:0] hello world this is a test about mtg');

      mockMergedResponse({
        summary: 'Video discusses MTG',
        takeaways: [],
        overall_sentiment: { score: 4, label: 'Positive' },
        entities: [],
        compact_text: '[T:0] hello world test mtg',
      });

      const result = await analyzeSignal(db, 'v-compact-store', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT compact_text FROM signals WHERE video_id = ?').get('v-compact-store') as { compact_text: string | null } | undefined;
      expect(sig!.compact_text).toBe('[T:0] hello world test mtg');
    });

    it('leaves compact_text NULL when LLM omits field', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-no-compact', 'text');

      mockMergedResponse({
        summary: 's',
        takeaways: [],
        overall_sentiment: { score: 3, label: 'Neutral' },
        entities: [],
      });

      await analyzeSignal(db, 'v-no-compact', config);

      const sig = db.prepare('SELECT compact_text FROM signals WHERE video_id = ?').get('v-no-compact') as { compact_text: string | null } | undefined;
      expect(sig!.compact_text).toBeNull();
    });

    it('prompt uses generic role "You are a content analyst"', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-role', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      await analyzeSignal(db, 'v-role', config);

      const prompt = JSON.parse(mockFetch.mock.calls[0][1].body as string).messages[0].content;
      expect(prompt).toContain('You are a content analyst');
      expect(prompt).not.toContain('MTG (Magic: The Gathering)');
    });

    it('channel with no topic_id processes correctly', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCnofilter');
      db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('v-nofilter', 'UCnofilter', 'Test', 'text', Date.now());

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      const result = await analyzeSignal(db, 'v-nofilter', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-nofilter') as { processing_state: string } | undefined;
      expect(sig!.processing_state).toBe('summarized');
    });

    it('handles LLM response with prose reasoning before trailing JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-prose', 'text');

      // Streaming: prose content streamed as tokens + extractTrailingJson finds the JSON at end
      const encoder = new TextEncoder();
      const proseContent = "Here's a thinking process:\n\n1. Analyze the input\n2. Check relevance - it matches\n3. Generate output\n\nSome reasoning with {braces} in the middle.\n\n{\"summary\":\"s\",\"takeaways\":[],\"overall_sentiment\":{\"score\":3,\"label\":\"Neutral\"},\"entities\":[]}";
      const sseLines = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: proseContent } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const readable = new ReadableStream({
        start(controller) {
          for (const line of sseLines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);

      const result = await analyzeSignal(db, 'v-prose', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT summary FROM signals WHERE video_id = ?').get('v-prose') as { summary: string | null } | undefined;
      expect(sig!.summary).toContain('s');
    });

    it('handles LLM response with prose before minimal irrelevant JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-irr-prose', 'text');

      // Streaming: prose + JSON at end, extractTrailingJson finds {"relevant": false}
      const encoder = new TextEncoder();
      const proseContent = "Thinking through this...\n\nThe content doesn't match. Decision: relevant=false, so return {\"relevant\": false}.\n\nDone. ✅\n{\"relevant\": false}";
      const sseLines = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: proseContent } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const readable = new ReadableStream({
        start(controller) {
          for (const line of sseLines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);

      const result = await analyzeSignal(db, 'v-irr-prose', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-irr-prose') as { processing_state: string } | undefined;
      expect(sig!.processing_state).toBe('irrelevant');
    });

    it('persists generated_title from LLM response', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-title', 'text about mtg news');

      mockMergedResponse({
        summary: 'MTG news update',
        takeaways: [],
        overall_sentiment: { score: 4, label: 'Positive' },
        entities: [],
        title: 'New MTG Set Announcement Changes Everything',
      });

      const result = await analyzeSignal(db, 'v-title', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT generated_title FROM signals WHERE video_id = ?').get('v-title') as { generated_title: string | null } | undefined;
      expect(sig!.generated_title).toBe('New MTG Set Announcement Changes Everything');
    });

    it('truncates generated_title to 100 characters', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-long-title', 'text');

      const longTitle = 'A'.repeat(150);
      mockMergedResponse({
        summary: 's',
        takeaways: [],
        overall_sentiment: { score: 3, label: 'Neutral' },
        entities: [],
        title: longTitle,
      });

      await analyzeSignal(db, 'v-long-title', config);

      const sig = db.prepare('SELECT generated_title FROM signals WHERE video_id = ?').get('v-long-title') as { generated_title: string | null } | undefined;
      expect(sig!.generated_title).toHaveLength(100);
      expect(sig!.generated_title).toBe('A'.repeat(100));
    });

    it('leaves generated_title NULL when LLM omits title field', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-no-title', 'text');

      mockMergedResponse({
        summary: 's',
        takeaways: [],
        overall_sentiment: { score: 3, label: 'Neutral' },
        entities: [],
      });

      await analyzeSignal(db, 'v-no-title', config);

      const sig = db.prepare('SELECT generated_title FROM signals WHERE video_id = ?').get('v-no-title') as { generated_title: string | null } | undefined;
      expect(sig!.generated_title).toBeNull();
    });

    it('existing signals retain NULL generated_title after migration', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-existing', 'text');

      // Signal created before title feature — generated_title should be NULL
      const sig = db.prepare('SELECT generated_title FROM signals WHERE video_id = ?').get('v-existing') as { generated_title: string | null } | undefined;
      expect(sig!.generated_title).toBeNull();
    });

    it('returns descriptive error for malformed streaming JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-struct', 'text');

      // Streaming path: content that is not valid JSON → extractTrailingJson returns it → parse fails
      const encoder = new TextEncoder();
      const sseLines = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'not json at all' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const readable = new ReadableStream({
        start(controller) {
          for (const line of sseLines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);

      const result = await analyzeSignal(db, 'v-struct', config);
      expect(result.success).toBe(false);
    });
  });

  // Regression: issue-174 - answer token counting in agent loop
  describe('issue #174 - answer token counting in agent loop', () => {
    function mockSseResponse(chunks: string[]) {
      const encoder = new TextEncoder();

      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: readable,
      } as any);
    }

    it('fires answering phase with incrementing token count every 5 tokens', async () => {
      const phases: any[] = [];
      const counts: number[] = [];

      // Simulate 12 content tokens (no tool calls)
      const chunks = [
        'data: {"choices":[{"delta":{"content":"token1"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token2"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token3"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token4"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token5"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token6"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token7"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token8"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token9"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token10"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token11"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"token12"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ];

      mockSseResponse(chunks);

      const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], {
        onPhaseChange: (phase, tokenCount) => {
          phases.push(phase);
          counts.push(tokenCount);
        },
      });

      // Replicate the agent loop token counting pattern from chat-manager.ts _runAgentLoop
      let answerTokenCount = 0;
      const answeringCountsFromLoop: number[] = [];

      for await (const _ of result.tokens) {
        answerTokenCount++;
        if (answerTokenCount % 5 === 0) {
          // This is what chat-manager does: fire onPhaseChange every 5 tokens
          answeringCountsFromLoop.push(answerTokenCount);
        }
      }

      // Fire final count when stream completes (if not already a multiple of 5)
      if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
        answeringCountsFromLoop.push(answerTokenCount);
      }

      // 12 tokens: fires at 5, 10, then final at 12
      expect(answeringCountsFromLoop).toEqual([5, 10, 12]);
    });

    it('fires answering phase with exact count when token count is multiple of 5', async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"d"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"e"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ];

      mockSseResponse(chunks);

      const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

      let answerTokenCount = 0;
      const answeringCountsFromLoop: number[] = [];

      for await (const _ of result.tokens) {
        answerTokenCount++;
        if (answerTokenCount % 5 === 0) {
          answeringCountsFromLoop.push(answerTokenCount);
        }
      }

      // Fire final count when stream completes
      if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
        answeringCountsFromLoop.push(answerTokenCount);
      }

      // Exactly 5 tokens: fires at 5, no extra final call (already multiple of 5)
      expect(answeringCountsFromLoop).toEqual([5]);
    });

    it('combined reasoning + answering phases with token counts', async () => {
      const phases: any[] = [];
      const counts: number[] = [];

      // Reasoning phase first, then content tokens
      mockSseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking1"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking2"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]);

      const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }], {
        onPhaseChange: (phase, tokenCount) => {
          phases.push(phase);
          counts.push(tokenCount);
        },
      });

      // Replicate agent loop pattern
      let answerTokenCount = 0;
      for await (const _ of result.tokens) {
        answerTokenCount++;
        if (answerTokenCount % 5 === 0) {
          // Would fire onPhaseChange('answering', answerTokenCount) in real agent loop
        }
      }

      // NOTE: callLlmStreamWithTools no longer fires 'intake' — the caller (chat-manager)
      // handles intake for round tracking. Verify phases from callLlmStreamWithTools include reasoning, answering, done.
      expect(phases).not.toContain('intake');
      expect(phases).toContain('reasoning');
      expect(phases).toContain('answering');
      expect(phases).toContain('done');

      // Reasoning phase should have token counts 1 and 2
      const reasoningPhaseIndices = phases.map((p, i) => p === 'reasoning' ? i : -1).filter(i => i >= 0);
      expect(reasoningPhaseIndices.length).toBe(2);
      expect(counts[reasoningPhaseIndices[0]]).toBe(1);
      expect(counts[reasoningPhaseIndices[1]]).toBe(2);

      // 2 answer tokens, not a multiple of 5, so final count would fire at 2
      expect(answerTokenCount).toBe(2);
    });
  });
});

// =============================================================================
// Regression: issue-158 — analyzeSignal streaming migration
// =============================================================================

describe('Regression: issue-158 — analyzeSignal streaming with phase callback', () => {
  function mockSseStreamingResponse(chunks: Array<{ reasoning?: string; content?: string; finishReason?: string }>) {
    const encoder = new TextEncoder();
    const lines: string[] = [];

    for (const chunk of chunks) {
      const delta: Record<string, unknown> = {};
      if (chunk.reasoning !== undefined) delta.reasoning_content = chunk.reasoning;
      if (chunk.content !== undefined) delta.content = chunk.content;

      const choice: Record<string, unknown> = { delta };
      if (chunk.finishReason) choice.finish_reason = chunk.finishReason;

      lines.push(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
    }
    lines.push('data: [DONE]\n\n');

    const readable = new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);
  }

  it('fires onPhaseChange callbacks for intake → reasoning phases', async () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v-reg-158-1', 'text about mtg');

    mockSseStreamingResponse([
      { reasoning: 'Thinking...' },
      { content: '{"summary":"MTG video","takeaways":[],"overall_sentiment":{"score":4,"label":"Positive"},"entities":[]}' },
      { finishReason: 'stop' },
    ]);

    const phases: Array<string> = [];
    const result = await analyzeSignal(db, 'v-reg-158-1', config, undefined, (phase) => {
      phases.push(phase);
    });

    expect(result.success).toBe(true);
    expect(phases).toContain('intake');
  });

  it('handles relevant:false via streaming response', async () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v-reg-158-irr', 'text');

    mockSseStreamingResponse([
      { reasoning: 'Not relevant...' },
      { content: '{"relevant":false}' },
      { finishReason: 'stop' },
    ]);

    const result = await analyzeSignal(db, 'v-reg-158-irr', config);
    expect(result.success).toBe(true);

    const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-reg-158-irr') as { processing_state: string } | undefined;
    expect(sig!.processing_state).toBe('irrelevant');
  });
});

// =============================================================================
// Regression: issue-174 — answer token counting in agent loop
// =============================================================================

describe('Regression: issue-174 — answer token counting fires at correct intervals', () => {
  it('12 tokens: fires answering at 5, 10, then final at 12', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"token1"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token2"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token3"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token4"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token5"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token6"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token7"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token8"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token9"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token10"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token11"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"token12"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ];

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

    let answerTokenCount = 0;
    const answeringCountsFromLoop: number[] = [];

    for await (const _ of result.tokens) {
      answerTokenCount++;
      if (answerTokenCount % 5 === 0) {
        answeringCountsFromLoop.push(answerTokenCount);
      }
    }

    if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
      answeringCountsFromLoop.push(answerTokenCount);
    }

    expect(answeringCountsFromLoop).toEqual([5, 10, 12]);
  });

  it('exactly 5 tokens: fires only at 5 (no extra final call)', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"d"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"e"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ];

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, body: readable } as any);

    const result = await callLlmStreamWithTools(config, 'test prompt', [{ type: 'function', function: { name: 'noop', parameters: {} } }]);

    let answerTokenCount = 0;
    const answeringCountsFromLoop: number[] = [];

    for await (const _ of result.tokens) {
      answerTokenCount++;
      if (answerTokenCount % 5 === 0) {
        answeringCountsFromLoop.push(answerTokenCount);
      }
    }

    if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
      answeringCountsFromLoop.push(answerTokenCount);
    }

    expect(answeringCountsFromLoop).toEqual([5]);
  });
});

// =============================================================================
// Qwen XML response handling (from llm-qwen-xml.test.ts)
// =============================================================================

/** Helper to build a valid SSE data line with proper JSON escaping */
function sseContent(content: string): string {
  const json = JSON.stringify({ choices: [{ delta: { content } }] });
  return `data: ${json}\n\n`;
}

describe('Qwen XML tool call parsing', () => {
  it('parses single Qwen XML tool call from content stream', async () => {
    const xmlContent = '<tool_code>\n' +
      '<parameter_code>get_compact_text</parameter_code>\n' +
      '<parameter_code>{"video_id":"RPEzKMfsJvg"}</parameter_code>\n' +
      '</tool_code>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config,
      'Tell me about this video',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.video_id).toBe('RPEzKMfsJvg');
  });

  it('parses Qwen XML tool call fragmented across multiple SSE chunks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        sseContent('<tool_code>\n'),
        sseContent('<parameter_code>get_compact_text</parameter_code>\n'),
        sseContent('<parameter_code>{"video_id":"RPEzKMfsJvg"}</parameter_code>\n'),
        sseContent('</tool_code>'),
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(
      config,
      'Tell me about this video',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
  });

  it('does not produce tool calls when content has no Qwen XML', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        sseContent('Hello'),
        sseContent(' world'),
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(
      config,
      'Say hello',
      [{ type: 'function', function: { name: 'noop', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(result.toolCalls).toHaveLength(0);
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('fires retrieving phase when Qwen XML tool call is detected', async () => {
    const phases: string[] = [];

    const xmlContent = '<tool_code>\n' +
      '<parameter_code>lookup</parameter_code>\n' +
      '<parameter_code>{"x":1}</parameter_code>\n' +
      '</tool_code>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config,
      'test',
      [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      { onPhaseChange: (phase) => phases.push(phase) }
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('retrieving');
  });

  it('assigns a generated id to Qwen XML tool calls', async () => {
    const xmlContent = '<tool_code>\n' +
      '<parameter_code>fn</parameter_code>\n' +
      '<parameter_code>{"a":1}</parameter_code>\n' +
      '</tool_code>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(xmlContent), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config, 'test',
      [{ type: 'function', function: { name: 'fn', parameters: {} } }]
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBeDefined();
    expect(typeof result.toolCalls[0].id).toBe('string');
    expect(result.toolCalls[0].id.length).toBeGreaterThan(0);
  });

  // ─── Format B (anthropic-style tool use) ──────────────────────

  it('parses Format B anthropic-style tool call', async () => {
    const formatB = '<tool_call> <function=get_compact_text> <parameter=videoIds> ["SG3tuA8zqs8"] </parameter> </function> </tool_call>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(formatB), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config,
      'Tell me about this video',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    expect(args.videoIds).toEqual(['SG3tuA8zqs8']);
  });

  it('parses Format B with reasoning text before tool call', async () => {
    const content = 'Let me retrieve the compact transcription.\n<tool_call> <function=get_compact_text> <parameter=videoIds> ["ABC123"] </parameter> </function> </tool_call>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(content), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config, 'test',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
    const joined = tokens.join('');
    expect(joined).toContain('compact transcription');
  });

  it('fires retrieving phase when Format B tool call is detected', async () => {
    const phases: string[] = [];
    const formatB = '<tool_call> <function=lookup> <parameter=x> 1 </parameter> </function> </tool_call>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([sseContent(formatB), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
    } as any);

    const result = await callLlmStreamWithTools(
      config, 'test',
      [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      { onPhaseChange: (phase) => phases.push(phase) }
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('retrieving');
  });

  it('handles Qwen XML with heavily fragmented single characters', async () => {
    const xmlParts = [
      '<', 't', 'o', 'o', 'l', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>',
      'g', 'e', 't', '_', 'c', 'o', 'm', 'p', 'a', 'c', 't', '_', 't', 'e', 'x', 't',
      '</', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>',
      '{', '"', 'v', 'i', 'd', 'e', 'o', '_', 'i', 'd', '"', ':', '"', 'A', 'B', 'C', '"', '}',
      '</', 'p', 'a', 'r', 'a', 'm', 'e', 't', 'e', 'r', '_', 'c', 'o', 'd', 'e', '>', '\n',
      '<', '/', 't', 'o', 'o', 'l', '_', 'c', 'o', 'd', 'e', '>',
    ];

    const chunks = xmlParts.map(ch => sseContent(ch));
    chunks.push('data: {"choices":[{"finish_reason":"stop"}]}\n\n');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream(chunks),
    } as any);

    const result = await callLlmStreamWithTools(
      config, 'test',
      [{ type: 'function', function: { name: 'get_compact_text', parameters: {} } }]
    );

    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_compact_text');
  });
});

// =============================================================================
// Streaming phase detection (from llm-stream-phases.test.ts)
// =============================================================================

describe('callLlmStreamWithPhases', () => {
  it('fires intake callback at request-send time with tokenCount=0', async () => {
    const phases: string[] = [];
    const counts: number[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => { phases.push(phase); counts.push(tokenCount); },
    })) { /* consume */ }

    expect(phases).toContain('intake');
    const intakeIndex = phases.indexOf('intake');
    expect(counts[intakeIndex]).toBe(0);
  });

  it('fires reasoning when first SSE chunk has delta.reasoning_content', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking about this"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase) => phases.push(phase),
    })) { /* consume */ }

    expect(phases).toContain('reasoning');
  });

  it('fires answering when SSE chunks switch to delta.content after reasoning, passing cumulative reasoning token count', async () => {
    const phases: string[] = [];
    const counts: number[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" more thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => { phases.push(phase); counts.push(tokenCount); },
    })) { /* consume */ }

    expect(phases).toContain('answering');
    const answeringIndex = phases.indexOf('answering');
    expect(counts[answeringIndex]).toBeGreaterThan(0);
  });

  it('fires done on finish_reason stop with total token count (reasoning + content)', async () => {
    const phases: string[] = [];
    const counts: number[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => { phases.push(phase); counts.push(tokenCount); },
    })) { /* consume */ }

    expect(phases).toContain('done');
    const doneIndex = phases.indexOf('done');
    expect(counts[doneIndex]).toBeGreaterThan(0);
  });

  it('generator yields only content tokens, never reasoning_content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"internal thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"public answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const tokens: string[] = [];
    for await (const token of callLlmStreamWithPhases(config, 'test prompt', { onPhaseChange: () => {} })) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['public answer']);
    expect(tokens).not.toContain('internal thought');
  });

  it('verifies cumulative token counting across phases', async () => {
    const counts: number[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"aaa"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"bbb"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ccc"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ddd"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (_phase, tokenCount) => counts.push(tokenCount),
    })) { /* consume */ }

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it('fires all four phase transitions in correct order', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase) => phases.push(phase),
    })) { /* consume */ }

    expect(phases).toEqual(['intake', 'reasoning', 'answering', 'done']);
  });

  it('works without onPhaseChange callback (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const tokens: string[] = [];
    for await (const token of callLlmStreamWithPhases(config, 'test prompt')) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['hello']);
  });

  it('fires intake and done with no reasoning phase when only content', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"direct answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase) => phases.push(phase),
    })) { /* consume */ }

    expect(phases).toEqual(['intake', 'answering', 'done']);
  });

  it('supports abortSignal for cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });

    const gen = callLlmStreamWithPhases(config, 'prompt', { abortSignal: controller.signal });
    let error;
    try { await gen.next(); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect((error as Error).message.toLowerCase()).toMatch(/abort/i);
  });
});

// =============================================================================
// Token count updates (from llm-stream-token-update.test.ts)
// =============================================================================

describe('callLlmStreamWithPhases - continuous token count updates', () => {
  it('fires onPhaseChange with updated tokenCount for each reasoning chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"aaa"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"bbb"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"ccc"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');
    expect(reasoningCalls.length).toBe(3);
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(reasoningCalls[1].tokenCount).toBe(2);
    expect(reasoningCalls[2].tokenCount).toBe(3);
  });

  it('fires onPhaseChange with updated tokenCount for each content chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"aaa"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"bbb"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ccc"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const answeringCalls = calls.filter(c => c.phase === 'answering');
    expect(answeringCalls.length).toBe(3);
    expect(answeringCalls[0].tokenCount).toBe(1);
    expect(answeringCalls[1].tokenCount).toBe(2);
    expect(answeringCalls[2].tokenCount).toBe(3);
  });

  it('accumulates reasoning + content tokens across phase transition with continuous updates', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"aa"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"bb"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"cc"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"dd"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');
    expect(reasoningCalls.length).toBe(2);
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(reasoningCalls[1].tokenCount).toBe(2);

    const answeringCalls = calls.filter(c => c.phase === 'answering');
    expect(answeringCalls.length).toBe(2);
    expect(answeringCalls[0].tokenCount).toBe(3);
    expect(answeringCalls[1].tokenCount).toBe(4);

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(4);
  });
});

// =============================================================================
// Tool calling in streams (from llm-stream-tools.test.ts)
// =============================================================================

describe('callLlmStreamWithTools', () => {
  it('fires retrieving phase when tool_calls are detected in SSE delta', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"Let me check"}}]}\n\n',
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{\\\"city\\\":\\\"London\\\""}}]}}]}\n\n`,
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'What is the weather in London?', [
      { type: 'function', function: { name: 'get_weather', parameters: {} } }
    ], { onPhaseChange: (phase) => phases.push(phase) });
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('retrieving');
  });

  it('yields content tokens from SSE stream', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const tokens: string[] = [];
    const result = await callLlmStreamWithTools(config, 'test prompt', [
      { type: 'function', function: { name: 'noop', parameters: {} } }
    ]);
    for await (const token of result.tokens) tokens.push(token);

    expect(tokens).toEqual(['hello', ' world']);
  });

  it('accumulates tool_calls from SSE delta chunks and returns them', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}}]}\n\n`,
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'What is the weather?', [
      { type: 'function', function: { name: 'get_weather', parameters: {} } }
    ]);
    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_xyz');
    expect(result.toolCalls[0].function.name).toBe('get_weather');
  });

  it('handles multiple tool calls in a single response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"tool_a","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"tool_b","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'do multiple things', [
      { type: 'function', function: { name: 'tool_a', parameters: {} } },
      { type: 'function', function: { name: 'tool_b', parameters: {} } },
    ]);
    for await (const _ of result.tokens) { /* consume */ }

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe('tool_a');
    expect(result.toolCalls[1].function.name).toBe('tool_b');
  });

  it('does NOT fire intake phase — caller handles intake for round tracking', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test', [
      { type: 'function', function: { name: 'x', parameters: {} } }
    ], { onPhaseChange: (phase) => phases.push(phase) });
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).not.toContain('intake');
    expect(phases).toContain('done');
  });

  it('fires done phase on finish_reason stop', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test', [
      { type: 'function', function: { name: 'x', parameters: {} } }
    ], { onPhaseChange: (phase) => phases.push(phase) });
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('done');
  });

  it('phase sequence with tool calls: answering -> retrieving -> done', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"checking"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test', [
      { type: 'function', function: { name: 'lookup', parameters: {} } }
    ], { onPhaseChange: (phase) => phases.push(phase) });
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toEqual(['answering', 'retrieving', 'done']);
  });

  it('sends tools array in request body with stream:true', async () => {
    const capturedBodies: any[] = [];
    mockFetch.mockImplementation(async (url, init) => {
      capturedBodies.push(JSON.parse((init as any).body as string));
      return {
        ok: true,
        body: createSseStream(['data: {"choices":[{"finish_reason":"stop"}]}\n\n']),
      } as any;
    });

    const tools = [{ type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } }];
    await callLlmStreamWithTools(config, 'weather?', tools);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].tools).toEqual(tools);
    expect(capturedBodies[0].stream).toBe(true);
  });

  it('works without onPhaseChange callback (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test prompt', [
      { type: 'function', function: { name: 'noop', parameters: {} } }
    ]);

    const tokens: string[] = [];
    for await (const token of result.tokens) tokens.push(token);

    expect(tokens).toEqual(['hello']);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

    await expect(callLlmStreamWithTools(config, 'prompt', [])).rejects.toThrow('LLM stream tools HTTP 500 Internal Server Error');
  });

  it('supports abortSignal for cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockImplementation(() => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });

    await expect(callLlmStreamWithTools(config, 'prompt', [], { abortSignal: controller.signal })).rejects.toThrow(/abort/i);
  });

  // Issue #175: reasoning_content detection in callLlmStreamWithTools
  it('detects delta.reasoning_content and fires reasoning phase with token count', async () => {
    const phases: string[] = [];
    const counts: number[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"more thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test prompt', [
      { type: 'function', function: { name: 'noop', parameters: {} } }
    ], { onPhaseChange: (phase, tokenCount) => { phases.push(phase); counts.push(tokenCount); } });
    for await (const _ of result.tokens) { /* consume */ }

    expect(phases).toContain('reasoning');
    const reasoningCalls = phases.filter((p, i) => p === 'reasoning' && counts[i] >= 1);
    expect(reasoningCalls.length).toBe(2);
    expect(counts[phases.indexOf('reasoning')]).toBe(1);
  });

  it('reasoning phase fires before answering when reasoning_content precedes content', async () => {
    const phases: string[] = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const result = await callLlmStreamWithTools(config, 'test prompt', [
      { type: 'function', function: { name: 'noop', parameters: {} } }
    ], { onPhaseChange: (phase) => phases.push(phase) });
    for await (const _ of result.tokens) { /* consume */ }

    const reasoningIdx = phases.indexOf('reasoning');
    const answeringIdx = phases.indexOf('answering');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(answeringIdx).toBeGreaterThan(reasoningIdx);
  });

  it('does not yield reasoning_content tokens to the consumer', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"internal thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"visible answer"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    const tokens: string[] = [];
    const result = await callLlmStreamWithTools(config, 'test prompt', [
      { type: 'function', function: { name: 'noop', parameters: {} } }
    ]);
    for await (const token of result.tokens) tokens.push(token);

    expect(tokens).toEqual(['visible answer']);
    expect(tokens.join('')).not.toContain('internal thought');
  });
});

// =============================================================================
// Token counting (from llm-token-count.test.ts)
// =============================================================================

describe('callLlmStreamWithPhases - token count accuracy (issue #160)', () => {
  it('sends stream_options: { include_usage: true } in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt')) { /* consume */ }

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('uses usage.completion_tokens from final chunk for done phase', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"some reasoning text here"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part one"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer part two"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":42,"total_tokens":542}}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(42);
  });

  it('counts chunks during streaming, then corrects to actual usage at done', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"aaaaaaaaaa"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"bbbbbbbbbb"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const reasoningCalls = calls.filter(c => c.phase === 'reasoning');
    const answeringCalls = calls.filter(c => c.phase === 'answering');
    const doneCalls = calls.filter(c => c.phase === 'done');

    expect(reasoningCalls.length).toBe(1);
    expect(reasoningCalls[0].tokenCount).toBe(1);
    expect(answeringCalls.length).toBe(1);
    expect(answeringCalls[0].tokenCount).toBe(2);
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(5);
  });

  it('uses reasoning_tokens from usage details when available', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking about this"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"the answer is 42"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130,"completion_tokens_details":{"reasoning_tokens":18}}}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(30);
  });

  it('falls back to chunk count when usage not present in final chunk', async () => {
    const calls: Array<{ phase: string; tokenCount: number }> = [];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createSseStream([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      ]),
    } as any);

    for await (const _token of callLlmStreamWithPhases(config, 'test prompt', {
      onPhaseChange: (phase, tokenCount) => calls.push({ phase, tokenCount }),
    })) { /* consume */ }

    const doneCalls = calls.filter(c => c.phase === 'done');
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0].tokenCount).toBe(2);
  });
});

// =============================================================================
// Tool calling (from llm-tool-calling.test.ts)
// =============================================================================

describe('callLlmWithTools', () => {
  it('sends tools array in request body', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get the current weather in a location',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'The city name' } },
            required: ['city'],
          },
        },
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc123',
              type: 'function',
              function: JSON.stringify({ name: 'get_weather', arguments: '{"city":"London"}' }),
            }],
          },
        }],
      }),
    } as any);

    const result = await callLlmWithTools(
      { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
      'What is the weather in London?',
      tools
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toEqual(tools);
    expect(body.messages).toEqual([{ role: 'user', content: 'What is the weather in London?' }]);
  });

  it('returns tool_calls with function name and arguments', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_xyz789',
              type: 'function',
              function: JSON.stringify({ name: 'get_weather', arguments: '{"city":"London"}' }),
            }],
          },
        }],
      }),
    } as any);

    const result = await callLlmWithTools(
      { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
      'What is the weather?',
      [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_xyz789');
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ city: 'London' });
  });

  it('throws when response has no tool_calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'I cannot answer that.', role: 'assistant' } }],
      }),
    } as any);

    await expect(
      callLlmWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'What is the weather?',
        [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
      )
    ).rejects.toThrow('LLM tool calling returned unexpected response');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as any);

    await expect(
      callLlmWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'prompt', []
      )
    ).rejects.toThrow('LLM tool calling HTTP 500 Internal Server Error');
  });
});

/** Integration smoke test — skipped by default */
describe('callLlmStreamWithTools smoke test', () => {
  it.skip(
    'Qwen XML tool calling works on local LM Studio with qwen/qwen3.6-27b',
    async () => {
      const tools = [
        {
          type: 'function' as const,
          function: {
            name: 'add_numbers',
            description: 'Add two numbers together',
            parameters: {
              type: 'object',
              properties: { a: { type: 'number', description: 'First number' }, b: { type: 'number', description: 'Second number' } },
              required: ['a', 'b'],
            },
          },
        },
      ];

      const result = await callLlmStreamWithTools(
        { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen/qwen3.6-27b' },
        'Add 3 and 5', tools
      );

      for await (const _ of result.tokens) { /* consume */ }

      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls[0].function.name).toBe('add_numbers');

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.a).toBeDefined();
      expect(args.b).toBeDefined();
    },
    120_000
  );
});

/** Helper: create a ReadableStream from SSE chunks */
function createSseStream(chunks: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
