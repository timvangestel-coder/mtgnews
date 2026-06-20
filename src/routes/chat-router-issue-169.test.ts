import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';

// Mock LLM so tests don't hit real API
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    yield 'test answer';
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
let chatQueue: ChatQueue;

function insertSignal(videoId: string) {
  addChannel(db, 'UCtest', 'Test Channel');
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

describe('Issue #169 — retrieving phase label in _chatAnswerStatus.ejs', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    insertSignal('video-169-1');

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

  /* Tracer bullet: retrieving phase renders "Retrieving context..." via HTMX */

  it('HTMX status endpoint shows "Retrieving context..." when phase is retrieving', async () => {
    // Insert a pending row
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

  /* No regression: existing phase labels still work */

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
    // Manually update the entry to have round=2 (simulating a second intake)
    const existing = (chatQueue as any)._phaseRegistry.get(chatId);
    if (existing) {
      (chatQueue as any)._phaseRegistry.set(chatId, existing.phase, existing.tokenCount);
      // Force round=2 by setting intake again then back to reasoning
      (chatQueue as any)._phaseRegistry.set(chatId, 'intake', 0);
      expect((chatQueue as any)._phaseRegistry.get(chatId)!.round).toBe(2);
      (chatQueue as any)._phaseRegistry.set(chatId, 'reasoning', 500);
    }

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
