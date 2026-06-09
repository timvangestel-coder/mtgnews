import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../tests/fixtures/test-db';

// Mock LLM streaming
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    yield 'Hello ';
    yield 'test ';
    yield 'answer.';
  },
}));

import { ChatManager } from '../services/chat-manager';
import { createChatRouter } from './chat-router';

function insertSignal(db: Database.Database, videoId: string) {
  db.prepare(
    "INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)"
  ).run('UCtest', 'Test Channel', Date.now());
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

// ─── Bug 2: Mixed scope validation ──────────────────────────

describe('chat-router — Bug 2: mixed scope validation (issue #135)', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeAll(() => {
    db = createTestDb();
    insertSignal(db, 'video-mixed-1');

    const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });

    app = express();
    app.use(express.json());
    app.use(createChatRouter(chatManager));
  });

  afterAll(() => {
    db.close();
  });

  it('returns 400 when both signalVideoId and topicKey are present', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-mixed-1',
      topicKey: 'mtg',
      question: 'Mixed scope?',
    });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toBeDefined();
  });

  it('returns 400 when both signalVideoId and channelId are present', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-mixed-1',
      channelId: 'UC_test',
      question: 'Mixed scope?',
    });

    expect(resp.status).toBe(400);
  });

  it('returns 400 when signalVideoId, topicKey, and channelId all present', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-mixed-1',
      topicKey: 'mtg',
      channelId: 'UC_test',
      question: 'All mixed?',
    });

    expect(resp.status).toBe(400);
  });

  it('accepts signalVideoId alone (no regression)', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-mixed-1',
      question: 'Single scope?',
    });

    expect(resp.status).toBe(200);
  });
});

// ─── Bug 1: Double-format prevention ────────────────────────

describe('chat-router — Bug 1: double-format prevention (issue #135)', () => {
  let db: Database.Database;
  let app: express.Express;
  let chatManager: ChatManager;

  beforeAll(() => {
    db = createTestDb();
    insertSignal(db, 'video-dfmt-1');

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

  it('does NOT double-format pre-formatted answers in /chat/history', async () => {
    // Simulate a pre-formatted answer stored by _processSingleSignal or _processMultiSignal
    const preFormattedAnswer = 'The key point at <a href="#t-12000" class="inline-flex">[00:12]</a> is important.';

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, is_formatted) VALUES (?, ?, ?, ?)"
    ).run('video-dfmt-1', 'When is the key point?', preFormattedAnswer, 1);

    // Verify via ChatManager that is_formatted=1 is returned
    const history = chatManager.getHistory('video-dfmt-1');
    expect(history.length).toBe(1);
    expect(history[0].is_formatted).toBe(1);

    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-dfmt-1' });
    expect(resp.status).toBe(200);

    // Pre-formatted HTML should NOT be double-escaped by TimestampFormatter
    expect(resp.text).not.toContain('&lt;a');
    // The anchor tag should appear as raw HTML (EJS <%- outputs unescaped)
    expect(resp.text).toContain('<a href="#t-12000"');
  });

  it('formats raw answers once in /chat/history (no regression)', async () => {
    const rawAnswer = 'The timestamp T:45 shows the result.';

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('video-dfmt-1', 'What about T:45?', rawAnswer);

    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-dfmt-1' });
    expect(resp.status).toBe(200);

    // Raw answers should be formatted — T:45 becomes a timestamp pill [00:45]
    expect(resp.text).toContain('[00:45]');
  });

  it('preserves citation pill HTML in multi-signal answers', async () => {
    const citationAnswer = 'See <a href="/signals/abc123#t-60000" class="inline-flex">Video &middot; [01:00]</a> for details.';

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, is_formatted) VALUES (?, ?, ?, ?, ?)"
    ).run(null, 'Compare videos?', citationAnswer, 'mtg', 1);

    // Use topicKey query param to fetch list-scoped history
    const resp = await request(app).get('/chat/history').query({ topicKey: 'mtg' });
    expect(resp.status).toBe(200);

    // Citation pills should survive without double-escaping
    expect(resp.text).not.toContain('&lt;a');
    expect(resp.text).toContain('Video');
  });
});