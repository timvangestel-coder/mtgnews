import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initDb } from '../../src/db/init-db';
import { createServer } from '../../src/server';

test.describe('Signal page channel filter pills', () => {
  let testDb: Database.Database;
  let dbPath: string;
  let server: ReturnType<typeof createServer> | null = null;

  test.beforeAll(async () => {
    // Temp DB file so production server module can init
    dbPath = path.join(__dirname, '..', '.test-mtgnews.db');
    fs.mkdirSync(path.join(__dirname, '..'), { recursive: true });

    // Wipe any previous test DB
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    testDb = new Database(dbPath);
    initDb(testDb);

    // Seed topic
    testDb.prepare(
      "INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)"
    ).run('test', 'Test', 'Test content');

    // Seed channels with topic_id
    testDb.prepare(
      "INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at, topic_id) VALUES (?, ?, '', ?, ?, ?)"
    ).run('UC_alpha', 'Alpha Channel', 1, Date.now(), 1);
    testDb.prepare(
      "INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at, topic_id) VALUES (?, ?, '', ?, ?, ?)"
    ).run('UC_beta', 'Beta Channel', 1, Date.now(), 1);

    // Seed signals
    testDb.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid-alpha-1', 'UC_alpha', 'Alpha Video', '2101-12-31T00:00:00Z', '[]', 'alpha signal summary', 4, Date.now());
    testDb.prepare(
      `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('vid-beta-1', 'UC_beta', 'Beta Video', '2101-12-30T00:00:00Z', '[]', 'beta signal summary', 3, Date.now());

    // Start server with temp DB, scheduler off
    server = createServer({ port: 3001, startScheduler: false, database: testDb });
    // Wait for server ready
    await new Promise<void>((resolve) => {
      const check = () => {
        const addr = server!.server.address();
        if (addr) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  });

  test.afterAll(async () => {
    if (server) await server.close();
    testDb.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('channel filter pills render and filter signals via Alpine + HTMX', async ({ page }) => {
    await page.goto('http://localhost:3001/signals');

    // Wait for Alpine.js to initialize
    await page.waitForFunction(() => window.Alpine && Alpine.data, { timeout: 5000 });

    // "All Channels" pill active (blue bg); channel pills present
    const allPill = page.getByRole('button', { name: 'All Channels' });
    await expect(allPill).toBeVisible();
    expect(await allPill.getAttribute('class')).toContain('bg-blue-600');

    expect(page.getByRole('button', { name: 'Alpha Channel' })).toBeVisible();
    expect(page.getByRole('button', { name: 'Beta Channel' })).toBeVisible();

    // Both signals visible on /signals (no filter) — view renders title, not summary
    await expect(page.getByText('Alpha Video')).toBeVisible();
    await expect(page.getByText('Beta Video')).toBeVisible();

    // Click "Alpha Channel" pill → filters to alpha only
    await page.getByRole('button', { name: 'Alpha Channel' }).click();
    // Wait for HTMX to swap: beta signal disappears from #signals-table
    await expect(page.getByText('Beta Video')).toBeHidden({ timeout: 5000 });

    await expect(page.getByText('Alpha Video')).toBeVisible();

    // Alpha pill now blue, All pill gray
    expect(await page.getByRole('button', { name: 'Alpha Channel' }).getAttribute('class')).toContain('bg-blue-600');
    expect(await page.getByRole('button', { name: 'All Channels' }).getAttribute('class')).toContain('bg-gray-200');

    // Click "All Channels" pill → resets filter, both signals back
    await page.getByRole('button', { name: 'All Channels' }).click();
    // Wait for HTMX to swap: beta signal reappears
    await expect(page.getByText('Beta Video')).toBeVisible({ timeout: 5000 });

    await expect(page.getByText('Alpha Video')).toBeVisible();
    expect(await allPill.getAttribute('class')).toContain('bg-blue-600');
  });
});
