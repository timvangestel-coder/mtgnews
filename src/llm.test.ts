import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
import { analyzeSignal, LlmConfig, getLlmConfig } from './llm';

// Mock global fetch
const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
});

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

function insertChannel(db: Database.Database, channelId: string) {
  db.prepare(`
    INSERT INTO channels (channel_id, display_name, added_at)
    VALUES (?, ?, ?)
  `).run(channelId, 'Test Channel', Date.now());
}

function insertSignal(db: Database.Database, videoId: string, transcription: string) {
  db.prepare(`
    INSERT INTO signals (video_id, channel_id, title, transcription, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(videoId, 'UCtest', 'Test Video', transcription, Date.now());
}

function mockLlmResponse(json: unknown, options?: { times?: number }) {
  const response = {
    ok: true,
    json: () => Promise.resolve(json),
  };
  mockFetch.mockResolvedValue(response as any);
}

function mockLlmError(options?: { times?: number }) {
  const response = {
    ok: false,
    status: 500,
  };
  mockFetch.mockResolvedValue(response as any);
}

describe('llm', () => {
  describe('getLlmConfig', () => {
    it('reads LLM_ENDPOINT and LLM_MODEL from process.env', () => {
      const originalEndpoint = process.env.LLM_ENDPOINT;
      const originalModel = process.env.LLM_MODEL;

      process.env.LLM_ENDPOINT = 'http://custom:9999/v1/chat/completions';
      process.env.LLM_MODEL = 'custom/model';

      const config = getLlmConfig();

      expect(config.endpoint).toBe('http://custom:9999/v1/chat/completions');
      expect(config.model).toBe('custom/model');

      // Restore
      process.env.LLM_ENDPOINT = originalEndpoint;
      process.env.LLM_MODEL = originalModel;
    });

    it('returns defaults when env vars are unset', () => {
      const originalEndpoint = process.env.LLM_ENDPOINT;
      const originalModel = process.env.LLM_MODEL;

      delete process.env.LLM_ENDPOINT;
      delete process.env.LLM_MODEL;

      const config = getLlmConfig();

      expect(config.endpoint).toBe('http://127.0.0.1:1234/v1/chat/completions');
      expect(config.model).toBe('qwen/qwen3.6-27b');

      // Restore
      if (originalEndpoint !== undefined) process.env.LLM_ENDPOINT = originalEndpoint;
      if (originalModel !== undefined) process.env.LLM_MODEL = originalModel;
    });
  });

  const config: LlmConfig = {
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    model: 'qwen/qwen3.6-27b',
  };

  describe('analyzeSignal', () => {
    it('tracer bullet: produces summary and persists to signals', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v1', 'this is a test video about mtg');

      const summaryJson = {
        summary: 'Video discusses MTG topics',
        takeaways: [
          { text: 'Intro about MTG', timestamp: 'T:0' },
          { text: 'Card review segment', timestamp: 'T:10' },
        ],
      };

      const sentimentJson = { score: 4, label: 'Positive' };

      const entitiesJson = [
        { entity_name: 'Kaldra', entity_type: 'set', sentiment: 'Positive' },
      ];

      // 3 sequential fetch calls: summary, sentiment, entities
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(summaryJson) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(sentimentJson) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(entitiesJson) } }] }) as any });

      const result = await analyzeSignal(db, 'v1', config);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // verify db persisted
      const signal = db.prepare('SELECT summary, overall_sentiment, sentiment_label FROM signals WHERE video_id = ?').get('v1');
      expect(signal.summary).toContain('Video discusses MTG topics');
      expect(signal.overall_sentiment).toBe(4);
      expect(signal.sentiment_label).toBe('Positive');

      const mentions = db.prepare('SELECT entity_name, entity_type, sentiment FROM entity_mentions WHERE signal_video_id = ?').all('v1');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].entity_name).toBe('Kaldra');
    });

    it('summary includes T:ss timestamp references from transcription segments', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      const transcription = JSON.stringify([
        { text: 'hello world', start: 0, end: 2.5 },
        { text: 'mtg news today', start: 2.5, end: 5.0 },
        { text: 'kaldra is great', start: 10, end: 15 },
      ]);
      insertSignal(db, 'v2', transcription);

      const summaryJson = {
        summary: 'MTG news video',
        takeaways: [
          { text: 'Opening greeting', timestamp: 'T:0' },
          { text: 'Kaldra praise', timestamp: 'T:10' },
        ],
      };

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(summaryJson) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ score: 3, label: 'Neutral' }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify([]) } }] }) as any });

      await analyzeSignal(db, 'v2', config);

      // verify fetch was called with transcription text in the prompt
      const summaryCall = mockFetch.mock.calls[0][1] as any;
      const body = JSON.parse(summaryCall.body);
      expect(body.messages[0].content).toContain('hello world');
      expect(body.messages[0].content).toContain('mtg news today');
    });

    it('overall sentiment returns 1-5 integer score and label', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v3', 'some transcription text');

      // Test score = 5
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ summary: 's', takeaways: [] }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ score: 5, label: 'Very Positive' }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify([]) } }] }) as any });

      await analyzeSignal(db, 'v3', config);

      const signal = db.prepare('SELECT overall_sentiment, sentiment_label FROM signals WHERE video_id = ?').get('v3');
      expect(signal.overall_sentiment).toBe(5);
      expect(signal.sentiment_label).toBe('Very Positive');
    });

    it('per-entity sentiment persists array of entity objects', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v4', 'transcription about cards');

      const entitiesJson = [
        { entity_name: 'Lurrus', entity_type: 'creature', sentiment: 'Positive' },
        { entity_name: 'Dredge', entity_type: 'archetype', sentiment: 'Negative' },
        { entity_name: 'Modern', entity_type: 'format', sentiment: 'Neutral' },
      ];

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ summary: 's', takeaways: [] }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ score: 3, label: 'Neutral' }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(entitiesJson) } }] }) as any });

      await analyzeSignal(db, 'v4', config);

      const mentions = db.prepare('SELECT entity_name, entity_type, sentiment FROM entity_mentions WHERE signal_video_id = ? ORDER BY id').all('v4');
      expect(mentions).toHaveLength(3);
      expect(mentions[0]).toMatchObject({ entity_name: 'Lurrus', entity_type: 'creature', sentiment: 'Positive' });
      expect(mentions[1]).toMatchObject({ entity_name: 'Dredge', entity_type: 'archetype', sentiment: 'Negative' });
      expect(mentions[2]).toMatchObject({ entity_name: 'Modern', entity_type: 'format', sentiment: 'Neutral' });
    });

    it('handles failed LLM call gracefully - logs error, returns success false', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v5', 'transcription text');

      // First call (summary) fails
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any);

      const result = await analyzeSignal(db, 'v5', config);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // signal NOT updated (summary etc remain null)
      const signal = db.prepare('SELECT summary, overall_sentiment FROM signals WHERE video_id = ?').get('v5');
      expect(signal.summary).toBeNull();
      expect(signal.overall_sentiment).toBeNull();
    });

    it('handles malformed JSON response gracefully', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v6', 'transcription text');

      // Return non-JSON content
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'not json at all' } }] }) as any });

      const result = await analyzeSignal(db, 'v6', config);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('uses correct LM Studio endpoint and model', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v7', 'text');

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ summary: 's', takeaways: [] }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ score: 3, label: 'Neutral' }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify([]) } }] }) as any });

      await analyzeSignal(db, 'v7', config);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/v1/chat/completions',
        expect.any(Object)
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('qwen/qwen3.6-27b');
    });

    it('normalizes sentiment score to 1-5 range', async () => {
      const db = createTestDb();
      insertChannel(db, 'UCtest');
      insertSignal(db, 'v8', 'text');

      // LLM returns score out of range
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ summary: 's', takeaways: [] }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ score: 10, label: 'Positive' }) } }] }) as any });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify([]) } }] }) as any });

      await analyzeSignal(db, 'v8', config);

      const signal = db.prepare('SELECT overall_sentiment FROM signals WHERE video_id = ?').get('v8');
      expect(signal.overall_sentiment).toBe(5); // clamped to max
    });
  });
});