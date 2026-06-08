/**
 * Diagnosis test for 500 "Failed to enqueue question" bug.
 * Tests the full chain: POST /chat/ask → chatQueue.enqueue() → chatManager.submit()
 */
import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { ChatManager } from './services/chat-manager';
import { ConcurrencyPool } from './concurrency-pool';
import { createChatRouter } from './routes/chat-router';
import { ChatQueue } from './chat-queue';

let db: Database.Database;
let app: express.Express;

function insertSignal(videoId: string) {
  addChannel(db, 'UCtest', 'Test Channel');
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, 'UCtest', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

describe('chat enqueue 500 error diagnosis', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    insertSignal('video-test-1');

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

  it('returns 200 with pending status for valid signal + question', async () => {
    const resp = await request(app)
      .post('/chat/ask')
      .send({ signalVideoId: 'video-test-1', question: 'What is this about?' });
    
    console.log('[DEBUG-500] Response status:', resp.status);
    console.log('[DEBUG-500] Response body:', JSON.stringify(resp.body));
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('pending');
    expect(resp.body.id).toBeDefined();
  });

  it('returns 404 (not 500) when signal does not exist', async () => {
    const resp = await request(app)
      .post('/chat/ask')
      .send({ signalVideoId: 'nonexistent-signal-id', question: 'What is this about?' });
    
    console.log('[DEBUG-500] Nonexistent signal status:', resp.status);
    console.log('[DEBUG-500] Nonexistent signal body:', JSON.stringify(resp.body));
    expect(resp.status).toBe(404);
  });

  it('returns 400 when signalVideoId is empty string', async () => {
    const resp = await request(app)
      .post('/chat/ask')
      .send({ signalVideoId: '', question: 'What is this about?' });
    
    console.log('[DEBUG-500] Empty videoId status:', resp.status);
    console.log('[DEBUG-500] Empty videoId body:', JSON.stringify(resp.body));
    // Empty string should be rejected at validation layer
    expect([400, 404]).toContain(resp.status);
  });

  it('returns 400 when signalVideoId is undefined', async () => {
    const resp = await request(app)
      .post('/chat/ask')
      .send({ question: 'What is this about?' });
    
    console.log('[DEBUG-500] Missing videoId status:', resp.status);
    expect(resp.status).toBe(400);
  });

  it('returns 200 for multiple rapid enqueues (concurrency stress)', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        request(app)
          .post('/chat/ask')
          .send({ signalVideoId: 'video-test-1', question: `Question ${i}` })
      );
    }
    
    const responses = await Promise.all(promises);
    responses.forEach((resp, i) => {
      console.log(`[DEBUG-500] Stress test ${i}: status=${resp.status} body=${JSON.stringify(resp.body)}`);
      expect(resp.status).toBe(200);
    });
  });

  it('handles BigInt lastInsertRowid from better-sqlite3 v11', async () => {
    // better-sqlite3 v11 returns lastInsertRowid as BigInt on some platforms
    // The router must convert it to Number for JSON serialization
    const resp = await request(app)
      .post('/chat/ask')
      .send({ signalVideoId: 'video-test-1', question: 'BigInt test?' });
    
    console.log('[DEBUG-500] BigInt test status:', resp.status);
    console.log('[DEBUG-500] BigInt test body:', JSON.stringify(resp.body));
    console.log('[DEBUG-500] BigInt test id type:', typeof resp.body.id);
    
    expect(resp.status).toBe(200);
    // The id must be a JSON-safe number, not a BigInt string
    expect(typeof resp.body.id).toBe('number');
    expect(Number.isFinite(resp.body.id)).toBe(true);
  });
});