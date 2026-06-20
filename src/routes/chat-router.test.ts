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
  callLlmSync: vi.fn().mockResolvedValue('sync test answer'),
  getLlmConfig: () => ({ endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' }),
}));

import { ChatManager } from '../services/chat-manager';
import { ConcurrencyPool } from '../concurrency-pool';
import { createChatRouter } from './chat-router';
import { ChatQueue } from '../chat-queue';

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

// =============================================================================
// Regression: issue-135 — mixed scope validation + double-format prevention
// =============================================================================

describe('Regression: issue-135 — mixed scope validation', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-mixed-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

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

describe('Regression: issue-135 — double-format prevention', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-dfmt-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

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

  it('does NOT double-format pre-formatted answers in /chat/history', async () => {
    const preFormattedAnswer = 'The key point at [00:12] is important.';

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, is_formatted) VALUES (?, ?, ?, ?)"
    ).run('video-dfmt-1', 'When is the key point?', preFormattedAnswer, 1);

    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-dfmt-1' });
    expect(resp.status).toBe(200);

    // Pre-formatted answer should appear as-is without double-processing
    expect(resp.text).toContain('[00:12]');
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
    const citationAnswer = 'See Video for details.';

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, is_formatted) VALUES (?, ?, ?, ?, ?)"
    ).run(null, 'Compare videos?', citationAnswer, 'mtg', 1);

    // Use topicKey query param to fetch list-scoped history
    const resp = await request(app).get('/chat/history').query({ topicKey: 'mtg' });
    expect(resp.status).toBe(200);

    // Citation content should be preserved
    expect(resp.text).toContain('Video');
  });
});

// =============================================================================
// Regression: issue-169 — retrieving phase label + phase data attributes
// =============================================================================

describe('Regression: issue-169 — retrieving phase label in status endpoint', () => {
  let db: Database.Database;
  let app: express.Express;
  let chatQueue: ChatQueue;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-169-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

    const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
    const pool = new ConcurrencyPool(2);
    chatQueue = new ChatQueue(db, chatManager, pool);

    app = express();
    app.set('view engine', 'ejs');
    app.set('views', 'views');
    app.use(express.json());
    app.use(createChatRouter(chatManager, chatQueue));
  });

  afterAll(() => {
    db.close();
  });

  it('HTMX status endpoint shows "Retrieving context..." when phase is retrieving', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'What is MTG?');
    const chatId = Number(result.lastInsertRowid);

    // Inject retrieving phase into the PhaseRegistry via internal access
    (chatQueue as any)._phaseRegistry.set(chatId, 'retrieving', 42);

    // HTMX polling request
    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    // Must show "Retrieving context..." and NOT the fallback "processing..."
    expect(resp.text).toContain('Retrieving context...');
    expect(resp.text).not.toContain('processing...');
  });

  it('HTMX status endpoint shows "Intaking..." when phase is intake', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Intake test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'intake', 10);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('Intaking...');
  });

  it('HTMX status endpoint shows "Reasoning..." when phase is reasoning', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Reasoning test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 55);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('Reasoning...');
  });

  it('HTMX status endpoint shows "Answering..." when phase is answering', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Answering test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'answering', 120);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('Answering...');
  });

  /* Issue #173: Phase data attributes in rendered HTML */

  it('HTMX status endpoint includes data-chat-phase attribute with phase value', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Phase attr test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 347);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('data-chat-phase="reasoning"');
  });

  it('HTMX status endpoint includes data-chat-token-count attribute with token count value', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Token attr test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'answering', 891);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('data-chat-token-count="891"');
  });

  it('HTMX status endpoint includes data-chat-round attribute with round value', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Round attr test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 347);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('data-chat-round="1"');
  });

  it('HTMX status endpoint shows round indicator when round > 1', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'Round display test?');
    const chatId = Number(result.lastInsertRowid);

    // Set round=2 to simulate second agent loop iteration
    (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 500);
    // Force round=2 by setting intake again then back to reasoning
    (chatQueue as any)._phaseRegistry.set(chatId, 'intake', 0);
    expect((chatQueue as any)._phaseRegistry.get(chatId)!.round).toBe(2);
    (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 500);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`)
      .set('HX-Request', 'true');

    expect(resp.status).toBe(200);
    expect(resp.text).toContain('(Round 2)');
    expect(resp.text).toContain('data-chat-round="2"');
  });

  it('JSON status endpoint includes phase, tokenCount and round fields', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-169-1', 'JSON field test?');
    const chatId = Number(result.lastInsertRowid);

    (chatQueue as any)._phaseRegistry.set(chatId, 'retrieving', 250);

    const resp = await request(app)
      .get(`/chat/${chatId}/status`);

    expect(resp.status).toBe(200);
    expect(resp.body.phase).toBe('retrieving');
    expect(resp.body.tokenCount).toBe(250);
    expect(resp.body.round).toBe(1);
  });
});

// =============================================================================
// Regression: issue-173 — phase DOM attributes in /chat/history + JSON cleanup
// =============================================================================

describe('Regression: issue-173 — phase DOM attributes in /chat/history', () => {
  let db: Database.Database;
  let app: express.Express;
  let chatQueue: ChatQueue;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-173-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

    const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
    const pool = new ConcurrencyPool(2);
    chatQueue = new ChatQueue(db, chatManager, pool);

    app = express();
    app.set('view engine', 'ejs');
    app.set('views', 'views');
    app.use(express.json());
    app.use(createChatRouter(chatManager, chatQueue));
  });

  afterAll(() => {
    db.close();
  });

  it('includes data-chat-phase, data-chat-token-count, data-chat-round on pending answer divs', async () => {
    // Insert a pending row (answer = NULL)
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-173-1', 'Phase test question?');

    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-173-1' });
    expect(resp.status).toBe(200);
    // Pending row must include phase data attributes for JS polling to update
    expect(resp.text).toContain('data-chat-phase=""');
    expect(resp.text).toContain('data-chat-token-count="0"');
    expect(resp.text).toContain('data-chat-round="1"');
  });

  it('includes chat-phase-text class on pending answer span for JS updates', async () => {
    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-173-1' });
    expect(resp.status).toBe(200);
    // The phase text span must have the class so JS polling can target it
    expect(resp.text).toContain('chat-phase-text');
  });

  it('JSON status omits phase data when PhaseRegistry has no entry', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-173-1', 'No registry test?');
    const chatId = Number(result.lastInsertRowid);

    // Do NOT set anything in PhaseRegistry — simulate before processing starts
    const resp = await request(app).get(`/chat/${chatId}/status`);
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
    // phase, tokenCount, round are cleaned up (undefined fields removed) from JSON
    expect(resp.body.phase).toBeUndefined();
    expect(resp.body.tokenCount).toBeUndefined();
    expect(resp.body.round).toBeUndefined();
  });

  it('JSON status returns round > 1 when PhaseRegistry tracks multiple iterations', async () => {
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('video-173-1', 'Round tracking test?');
    const chatId = Number(result.lastInsertRowid);

    // Simulate first agent loop: intake fires (round=1), then reasoning
    chatQueue._phaseRegistry.set(chatId, 'intake', 0);
    expect(chatQueue._phaseRegistry.get(chatId)?.round).toBe(1);

    // Simulate second agent loop: intake fires again -> round increments to 2
    chatQueue._phaseRegistry.set(chatId, 'intake', 10);
    expect(chatQueue._phaseRegistry.get(chatId)?.round).toBe(2);

    const resp = await request(app).get(`/chat/${chatId}/status`);
    expect(resp.status).toBe(200);
    expect(resp.body.round).toBe(2);
  });
});

// =============================================================================
// Consolidated from chat-enqueue-500.test.ts — POST /chat/ask enqueue + status polling
// =============================================================================

describe('POST /chat/ask — enqueue when processing is in-flight (issue #146)', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-500-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

    const chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
    const pool = new ConcurrencyPool(2);
    const chatQueue = new ChatQueue(db, chatManager, pool);

    app = express();
    app.set('view engine', 'ejs');
    app.set('views', 'views');
    app.use(express.json());
    app.use(createChatRouter(chatManager, chatQueue));
  });

  afterAll(() => {
    db.close();
  });

  it('returns HTTP 200 with pending status and id when enqueuing', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-500-1',
      question: 'Enqueue test?',
    });

    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
    expect(resp.body.id).toBeDefined();
  });

  it('returns HTTP 200 with chatId that is a finite number', async () => {
    const resp = await request(app).post('/chat/ask').send({
      signalVideoId: 'video-500-1',
      question: 'BigInt safe test?',
    });

    expect(resp.status).toBe(200);
    expect(typeof resp.body.id).toBe('number');
    expect(Number.isFinite(resp.body.id)).toBe(true);

    // Verify the chat row was created and is accessible via status endpoint
    const statusResp = await request(app).get(`/chat/${resp.body.id}/status`);
    expect(statusResp.status).toBe(200);
  });
});

// =============================================================================
// Consolidated from chat-router-polymorphic.test.ts — route-level history polymorphism
// =============================================================================

describe('GET /chat/history — polymorphic scope (issue #130)', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    addChannel(db, 'UCtest', 'Test Channel');
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('video-poly-1', 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());

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

  it('returns list-scoped history when topicKey is present', async () => {
    // Seed a list-scoped row (signal_video_id = NULL, topic_key set)
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, ?, ?)"
    ).run(null, 'List scoped?', 'Yes list', 'mtg');

    const resp = await request(app).get('/chat/history').query({ topicKey: 'mtg' });
    expect(resp.status).toBe(200);
    expect(resp.text).toContain('List scoped?');
  });

  it('returns per-signal history when signalVideoId is present', async () => {
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('video-poly-1', 'Per-signal?', 'Yes signal');

    const resp = await request(app).get('/chat/history').query({ signalVideoId: 'video-poly-1' });
    expect(resp.status).toBe(200);
    expect(resp.text).toContain('Per-signal?');
  });
});
