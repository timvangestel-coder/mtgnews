import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { analyzeSignal, LlmConfig, getLlmConfig } from './llm';
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
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(json) } }] }),
  } as any);
}

const config: LlmConfig = {
  endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'qwen/qwen3.6-27b',
};

describe('llm', () => {
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
      const sig = db.prepare('SELECT summary, overall_sentiment, sentiment_label FROM signals WHERE video_id = ?').get('v1');
      expect(sig.summary).toContain('Video discusses MTG topics');
      expect(sig.overall_sentiment).toBe(4);
      expect(sig.sentiment_label).toBe('Positive');

      const mentions = db.prepare('SELECT entity_name FROM entity_mentions WHERE signal_video_id = ?').all('v1');
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

      const sig = db.prepare('SELECT overall_sentiment FROM signals WHERE video_id = ?').get('v3');
      expect(sig.overall_sentiment).toBe(5); // clamped to max
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

      const sig = db.prepare('SELECT summary, overall_sentiment FROM signals WHERE video_id = ?').get('v5');
      expect(sig.summary).toBeNull();
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

      const sig = db.prepare('SELECT processing_state, summary FROM signals WHERE video_id = ?').get('v-irrel');
      expect(sig.processing_state).toBe('irrelevant');
      expect(sig.summary).toBeNull();
    });

    it('missing relevant field -> backward compat, treated as relevant', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-backcompat', 'text');

      mockMergedResponse({ summary: 's', takeaways: [], overall_sentiment: { score: 3, label: 'Neutral' }, entities: [] });

      const result = await analyzeSignal(db, 'v-backcompat', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-backcompat');
      expect(sig.processing_state).toBe('summarized');
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
      expect(prompt).toMatch(/if.*not.*relevant.*return.*only|irrelevant.*return.*only.*relevant/i);
    });

    it('accepts minimal { relevant: false } response', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-min-irr', 'text');

      mockMergedResponse({ relevant: false });

      const result = await analyzeSignal(db, 'v-min-irr', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state, summary FROM signals WHERE video_id = ?').get('v-min-irr');
      expect(sig.processing_state).toBe('irrelevant');
      expect(sig.summary).toBeNull();
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

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-nofilter');
      expect(sig.processing_state).toBe('summarized');
    });

    it('handles LLM response with prose reasoning before trailing JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-prose', 'text');

      // Exact format: long prose reasoning (with braces scattered in text) + JSON at end
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "Here's a thinking process:\n\n1. Analyze the input\n2. Check relevance - it matches\n3. Generate output\n\nSome reasoning with {braces} in the middle.\n\n{\"summary\":\"s\",\"takeaways\":[],\"overall_sentiment\":{\"score\":3,\"label\":\"Neutral\"},\"entities\":[]}" } }] }),
      } as any);

      const result = await analyzeSignal(db, 'v-prose', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT summary FROM signals WHERE video_id = ?').get('v-prose');
      expect(sig.summary).toContain('s');
    });

    it('handles LLM response with prose before minimal irrelevant JSON', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-irr-prose', 'text');

      // Exact format: long reasoning that mentions {"relevant": false} in text + actual JSON at end
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "Thinking through this...\n\nThe content doesn't match. Decision: relevant=false, so return {\"relevant\": false}.\n\nDone. ✅\n{\"relevant\": false}" } }] }),
      } as any);

      const result = await analyzeSignal(db, 'v-irr-prose', config);
      expect(result.success).toBe(true);

      const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v-irr-prose');
      expect(sig.processing_state).toBe('irrelevant');
    });

    it('returns descriptive error for unexpected response structure', async () => {
      const db = createTestDb();
      seedChannel(db, 'UCtest');
      seedSignal(db, 'v-struct', 'text');

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [] }) as any });

      const result = await analyzeSignal(db, 'v-struct', config);
      expect(result.success).toBe(false);
      expect(result.error).toContain('unexpected response structure');
    });
  });
});