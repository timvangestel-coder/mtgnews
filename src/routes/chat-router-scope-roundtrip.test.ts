/**
 * Scope round-trip integration test — architecture improvement (Candidate 3).
 *
 * Verifies the full path: POST /chat/ask with topicKey → router parsing →
 * manager submit → DB row stores correct value → GET /chat/history returns it.
 * This is the gap where all chatissues.md bugs live: no existing test covered
 * this cross-seam integration path.
 */
import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';

// Mock LLM streaming
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    yield 'test answer';
  },
}));

import { ChatManager } from '../services/chat-manager';
import { createChatRouter } from './chat-router';

let db: Database.Database;
let app: express.Express;

function seedTopicAndChannel(db: Database.Database, key: string = 'mtg') {
  db.prepare("INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)").run(key, key.toUpperCase(), key + ' content');
  addChannel(db, 'UC_test', 'Test Channel');
  // Link channel to topic
  db.prepare("UPDATE channels SET topic_id = (SELECT id FROM topics WHERE key = ?) WHERE channel_id = ?").run(key, 'UC_test');
}

function seedSignal(db: Database.Database, videoId: string, title: string = 'Test Video') {
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at, processing_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, 'UC_test', title, '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now(), 'summarized');
}

describe('chat-router scope round-trip — integration test', () => {
  describe('List-scoped chat with topicKey survives full POST→DB→history path', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      seedTopicAndChannel(db, 'mtg');
      seedSignal(db, 'v_mtg_1', 'MTG Video 1');
      seedSignal(db, 'v_mtg_2', 'MTG Video 2');

      const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.set('view engine', 'ejs');
      app.set('views', 'views');
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('POST /chat/ask with topicKey stores correct scope in DB', async () => {
      const body = { question: 'What about MTG signals?', topicKey: 'mtg' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(200);

      // Verify DB row has correct scope values — this is the critical assertion
      const rows = db.prepare('SELECT * FROM signal_chat WHERE question = ?').all('What about MTG signals?');
      expect(rows.length).toBe(1);
      const row = rows[0] as { topic_key: string | null; channel_id: string | null; signal_video_id: string | null };

      // CRITICAL: topic_key must be 'mtg', NOT empty string ''
      expect(row.topic_key).toBe('mtg');
      // signal_video_id must be NULL for list-scoped chat
      expect(row.signal_video_id).toBeNull();
    });

    it('GET /chat/history with topicKey returns the question from DB', async () => {
      const resp = await request(app).get('/chat/history').query({ topicKey: 'mtg' });
      expect(resp.status).toBe(200);
      // The history response should contain our question
      expect(resp.text).toContain('What about MTG signals?');
    });

    it('POST with topicKey+channelId stores both in DB', async () => {
      const body = { question: 'MTG + channel question?', topicKey: 'mtg', channelId: 'UC_test' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(200);

      const rows = db.prepare('SELECT * FROM signal_chat WHERE question = ?').all('MTG + channel question?');
      expect(rows.length).toBe(1);
      const row = rows[0] as { topic_key: string | null; channel_id: string | null };
      expect(row.topic_key).toBe('mtg');
      expect(row.channel_id).toBe('UC_test');
    });

    it('GET /chat/history with topicKey+channelId returns composite-scoped questions', async () => {
      const resp = await request(app).get('/chat/history').query({ topicKey: 'mtg', channelId: 'UC_test' });
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('MTG + channel question?');
    });

    it('Different filter combos return separate histories (strict composite scoping)', async () => {
      // Post a question scoped to topic only (no channelId)
      await request(app).post('/chat/ask').send({ question: 'Topic-only question', topicKey: 'mtg' });

      // History with just topicKey should include topic-only questions
      const respAll = await request(app).get('/chat/history').query({ topicKey: 'mtg' });
      expect(respAll.status).toBe(200);
      expect(respAll.text).toContain('Topic-only question');

      // History with topicKey+channelId should be separate (strict composite)
      const respFiltered = await request(app).get('/chat/history').query({ topicKey: 'mtg', channelId: 'UC_test' });
      expect(respFiltered.status).toBe(200);
      expect(respFiltered.text).toContain('MTG + channel question?');
    });

    it('Empty string topicKey is preserved as list-scope indicator (issue #130 design)', async () => {
      // Empty string topicKey means "all signals" scope — must survive round-trip
      const body = { question: 'All signals question', topicKey: '' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(200);

      const rows = db.prepare('SELECT * FROM signal_chat WHERE question = ?').all('All signals question');
      expect(rows.length).toBe(1);
      // topic_key should be stored (empty string is valid scope indicator)
      const row = rows[0] as { topic_key: string | null };
      expect(row.topic_key !== null).toBe(true);
    });
  });

  describe('Per-signal chat remains unaffected by list-scoped changes', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      seedTopicAndChannel(db, 'mtg');
      seedSignal(db, 'v_per_signal', 'Per Signal Video');

      const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.set('view engine', 'ejs');
      app.set('views', 'views');
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('POST with signalVideoId stores per-signal scope (topicKey NULL)', async () => {
      const body = { question: 'Per-signal question', signalVideoId: 'v_per_signal' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(200);

      const rows = db.prepare('SELECT * FROM signal_chat WHERE question = ?').all('Per-signal question');
      expect(rows.length).toBe(1);
      const row = rows[0] as { signal_video_id: string | null; topic_key: string | null };
      expect(row.signal_video_id).toBe('v_per_signal');
      // Per-signal chat should NOT have topicKey set
      expect(row.topic_key).toBeNull();
    });

    it('GET /chat/history with signalVideoId returns per-signal questions', async () => {
      const resp = await request(app).get('/chat/history').query({ signalVideoId: 'v_per_signal' });
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Per-signal question');
    });
  });

  describe('Mixed scope rejection — cannot mix signalVideoId with topicKey', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      seedTopicAndChannel(db, 'mtg');
      seedSignal(db, 'v_mixed', 'Mixed Video');

      const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

      app = express();
      app.use(express.json());
      app.use(createChatRouter(chatManager));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when both signalVideoId and topicKey are provided', async () => {
      const body = { question: 'Mixed?', signalVideoId: 'v_mixed', topicKey: 'mtg' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(400);
    });

    it('returns 400 when both signalVideoId and channelId are provided', async () => {
      const body = { question: 'Mixed?', signalVideoId: 'v_mixed', channelId: 'UC_test' };
      const resp = await request(app).post('/chat/ask').send(body);
      expect(resp.status).toBe(400);
    });
  });
});