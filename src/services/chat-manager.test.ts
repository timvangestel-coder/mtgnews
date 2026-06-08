import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';

// Mock LLM module — both callLlmSync and callLlmStream
const mockCallLlmSync = vi.fn().mockResolvedValue('test answer');
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    yield 'token';
  },
  get callLlmSync() {
    return mockCallLlmSync;
  },
}));

import { ChatManager } from './chat-manager';

let db: Database.Database;
let chatManager: ChatManager;

function insertSignal(videoId: string) {
  db.prepare(
    `INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
  ).run(videoId + '_ch', 'Test Channel', Date.now());

  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, videoId + '_ch', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

describe('ChatManager two-phase persist', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    insertSignal('video-1');

    chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
  });

  afterAll(() => {
    db.close();
  });

  describe('submit()', () => {
    it('inserts row with answer=NULL and returns question ID', () => {
      const id = chatManager.submit('video-1', 'What is MTG?');
      expect(id).toBeTypeOf('number');
      expect(id).toBeGreaterThan(0);

      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id);
      expect(row).toBeDefined();
      // @ts-expect-error — answer column can be null
      expect(row.answer).toBeNull();
    });

    it('throws when signal not found', () => {
      expect(() => chatManager.submit('nonexistent', 'hi')).toThrow();
    });
  });

  describe('process()', () => {
    beforeEach(() => {
      mockCallLlmSync.mockClear().mockResolvedValue('test answer');
    });

    it('updates answer on successful LLM call', async () => {
      const id = chatManager.submit('video-1', 'Process me?');
      expect(id).toBeTypeOf('number');

      await chatManager.process(id);

      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
      expect(row.answer).toBe('test answer');
    });

    it('leaves answer=NULL when LLM call fails', async () => {
      mockCallLlmSync.mockRejectedValueOnce(new Error('LLM failed'));

      const id = chatManager.submit('video-1', 'Fail me?');
      await expect(chatManager.process(id)).rejects.toThrow('LLM failed');

      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
      // @ts-expect-error — answer can be null
      expect(row.answer).toBeNull();
    });
  });

  describe('getHistory() and delete()', () => {
    it('getHistory returns rows including NULL answers', () => {
      chatManager.submit('video-1', 'Pending question?');
      const history = chatManager.getHistory('video-1');
      const pending = history.find((h) => h.question === 'Pending question?');
      expect(pending).toBeDefined();
    });

    it('delete removes a row', () => {
      const id = chatManager.submit('video-1', 'Delete me?');
      chatManager.delete(id);
      const remaining = db.prepare('SELECT COUNT(*) as cnt FROM signal_chat WHERE id = ?').get(id);
      expect((remaining as { cnt: number }).cnt).toBe(0);
    });
  });
});