import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChatManager } from './chat-manager';
import * as llm from '../llm';

const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE topics (id INTEGER PRIMARY KEY, filter_text TEXT);
    CREATE TABLE channels (channel_id INTEGER PRIMARY KEY, topic_id INTEGER);
    CREATE TABLE signals (
      rowid INTEGER PRIMARY KEY,
      video_id TEXT UNIQUE,
      channel_id INTEGER,
      transcription TEXT,
      summary TEXT
    );
    CREATE TABLE signal_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_video_id TEXT,
      question TEXT,
      answer TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedSignal(db: Database.Database, videoId: string) {
  db.prepare("INSERT INTO topics (id, filter_text) VALUES (?, ?)").run(1, 'Magic');
  db.prepare("INSERT INTO channels (channel_id, topic_id) VALUES (?, ?)").run(1, 1);
  db.prepare("INSERT INTO signals (video_id, channel_id, transcription, summary) VALUES (?, ?, ?, ?)")
    .run(videoId, 1, JSON.stringify([{ time: 45000, text: 'hello world' }]), 'A test video');
}

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
  } as Response);
}

function sseChunk(content: string): string {
  return `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`;
}

const config: llm.LlmConfig = {
  endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
  model: 'test-model',
};

describe('ChatManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedSignal(db, 'vid-1');
  });

  afterEach(() => {
    db.close();
  });

  describe('ask() with transform', () => {
    it('applies transform to persisted answer after stream completes', async () => {
      const transform = vi.fn((t: string) => t.toUpperCase());
      mockSseResponse([sseChunk('T:45 mentioned '), sseChunk('in video'), 'data: [DONE]\n\n']);

      const manager = new ChatManager(db, config);
      const stream = manager.ask('vid-1', 'what time?', transform);

      for await (const _ of stream) { /* consume */ }

      // Transform was called
      expect(transform).toHaveBeenCalled();

      // Persisted answer is transformed
      const row = db.prepare('SELECT answer FROM signal_chat ORDER BY id DESC LIMIT 1').get() as { answer: string };
      expect(row.answer).toBe('T:45 MENTIONED IN VIDEO');
    });

    it('yields raw tokens during streaming (transform only applied post-stream)', async () => {
      const transform = vi.fn((t: string) => t.toUpperCase());
      mockSseResponse([sseChunk('hello '), sseChunk('world'), 'data: [DONE]\n\n']);

      const manager = new ChatManager(db, config);
      const stream = manager.ask('vid-1', 'q?', transform);

      const yielded: string[] = [];
      for await (const token of stream) {
        yielded.push(token);
      }

      // Tokens pass through unchanged during streaming
      expect(yielded.join('')).toBe('hello world');

      // But persisted answer is transformed
      const row = db.prepare('SELECT answer FROM signal_chat ORDER BY id DESC LIMIT 1').get() as { answer: string };
      expect(row.answer).toBe('HELLO WORLD');
    });

    it('skips transform when not provided', async () => {
      mockSseResponse([sseChunk('raw '), sseChunk('token'), 'data: [DONE]\n\n']);

      const manager = new ChatManager(db, config);
      const stream = manager.ask('vid-1', 'q?');

      const yielded: string[] = [];
      for await (const token of stream) {
        yielded.push(token);
      }

      // No transform — raw tokens passed through
      expect(yielded.join('')).toBe('raw token');

      const row = db.prepare('SELECT answer FROM signal_chat ORDER BY id DESC LIMIT 1').get() as { answer: string };
      expect(row.answer).toBe('raw token');
    });

    it('does not persist transformed answer when stream errors', async () => {
      const transform = vi.fn((t: string) => t.toUpperCase());
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' } as Response);

      const manager = new ChatManager(db, config);
      const stream = manager.ask('vid-1', 'q?', transform);

      await expect(async () => {
        for await (const _ of stream) { /* consume */ }
      }).rejects.toThrow();

      // No rows inserted on error
      const count = db.prepare('SELECT COUNT(*) AS c FROM signal_chat').get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe('ask() validation', () => {
    it('throws when signal not found', async () => {
      const manager = new ChatManager(db, config);
      const stream = manager.ask('missing', 'q?');

      await expect(async () => {
        for await (const _ of stream) { /* consume */ }
      }).rejects.toThrow('Signal missing not found');
    });
  });
});