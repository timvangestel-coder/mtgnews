const { test: base, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { initDb } = require('../../../src/db/init-db');
const { createServer } = require('../../../src/server');

const test = base.extend({
  db: [async ({}, use) => {
    const db = new Database(':memory:');
    initDb(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run('UC_test_channel_1', 'Test Channel 1', '', now);
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run('UC_test_channel_2', 'Test Channel 2', '', now);

    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)`
    ).run('mtg', 'MTG', 'Magic the Gathering content');
    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)`
    ).run('ai', 'AI', 'Artificial Intelligence news');

    // Assign topic to channel 1
    db.prepare(`UPDATE channels SET topic_id = 1 WHERE channel_id = ?`).run('UC_test_channel_1');

    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid_1', 'UC_test_channel_1', 'Signal One', '2026-05-01T10:00:00Z', '[]', 'Summary for signal one', 1, 'negative', now);
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid_2', 'UC_test_channel_1', 'Signal Two', '2026-05-02T10:00:00Z', '[]', 'Summary for signal two', 5, 'positive', now);
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid_3', 'UC_test_channel_2', 'Signal Three', '2026-05-03T10:00:00Z', '[]', 'Summary for signal three', 3, 'neutral', now);

    await use(db);

    db.close();
  }, { auto: true }],

  app: [async ({ db }, use) => {
    const app = createServer({ database: db, startScheduler: false });
    await use(app);
    await app.close();
  }, { auto: true }],

  baseUrl: [async ({ app }, use) => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    await use(`http://localhost:${port}`);
  }, { auto: true }],
});

module.exports = { test, expect };