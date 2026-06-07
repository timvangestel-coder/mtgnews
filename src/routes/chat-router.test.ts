import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';

// Mock LLM streaming
const mockToken = vi.fn();
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    const tokens = ['Hello ', 'this ', 'is ', 'a ', 'test ', 'answer.'];
    for (const t of tokens) {
      mockToken(t);
      yield t;
    }
  },
}));

import { ChatManager } from '../services/chat-manager';
import { createChatRouter } from './chat-router';

let db: Database.Database;
let app: express.Express;
let chatManager: ChatManager;

function insertSignal(videoId: string) {
  addChannel(db, 'UCtest', 'Test Channel');
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

describe('chat-router', () => {
  describe('POST /chat/ask', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      insertSignal('video-ask-1');

      chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('streams LLM tokens back for valid signalVideoId + question', async () => {
      const body = { signalVideoId: 'video-ask-1', question: 'What is this about?' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Hello');
      expect(resp.text).toContain('answer');
    });

    it('returns 400 when signalVideoId missing', async () => {
      const resp = await request(app).post('/chat/ask').send({ question: 'hi' });
      expect(resp.status).toBe(400);
    });

    it('returns 400 when question missing', async () => {
      const resp = await request(app).post('/chat/ask').send({ signalVideoId: 'video-ask-1' });
      expect(resp.status).toBe(400);
    });

    it('returns 404 when signal not found', async () => {
      const resp = await request(app)
        .post('/chat/ask')
        .send({ signalVideoId: 'nonexistent-video', question: 'hi' });
      expect(resp.status).toBe(404);
    });

    it('persists the answer in signal_chat table after stream completes', async () => {
      await request(app).post('/chat/ask').send({
        signalVideoId: 'video-ask-1',
        question: 'Persist test?',
      });

      const rows = db.prepare('SELECT * FROM signal_chat WHERE question = ?').all('Persist test?');
      expect(rows.length).toBe(1);
      expect((rows[0] as { answer: string }).answer).toContain('Hello');
    });
  });

  describe('GET /chat/history', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      insertSignal('video-history-1');

      chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.set('view engine', 'ejs');
      app.set('views', 'views');
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('returns HTMX fragment with Q&A pairs for given signalVideoId', async () => {
      // Seed a chat row directly
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
      ).run('video-history-1', 'What is MTG?', 'Magic: The Gathering');

      const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-history-1' });
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('What is MTG?');
      expect(resp.text).toContain('Magic: The Gathering');
    });

    it('returns empty fragment when no history', async () => {
      const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-no-history' });
      expect(resp.status).toBe(200);
    });
  });

  describe('DELETE /chat/:id', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      // Insert a signal so FK constraint on signal_chat is satisfied
      insertSignal('video-del-1');

      chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('removes the chat message and returns 204', async () => {
      const result = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
      ).run('video-del-1', 'Delete me?', 'yes');
      const insertId = (result as { lastInsertRowid: number }).lastInsertRowid;

      const resp = await request(app).delete(`/chat/${insertId}`);
      expect(resp.status).toBe(204);

      const remaining = db.prepare('SELECT COUNT(*) as cnt FROM signal_chat').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);
    });
  });
});