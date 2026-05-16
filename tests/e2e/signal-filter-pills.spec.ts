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

    // Seed channels
    testDb.prepare(
      "INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at) VALUES (?, ?, '', ?, ?)"
    ).run('UC_alpha', 'Alpha Channel', 1, Date.now());
    testDb.prepare(
      "INSERT INTO channels (channel_id, display_name, avatar_url, active, added_at) VALUES (?, ?, '', ?, ?)"
    ).run('UC_beta', 'Beta Channel', 1, Date.now());

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

    // Alpine x-data initialized (no console error from undefined Alpine)
    await expect(page.locator('[x-data]')).toBeAttached();

    // "All" pill active (blue bg); channel pills present
    const allPill = page.getByRole('button', { name: 'All' });
    await expect(allPill).toBeVisible();
    expect(await allPill.getAttribute('class')).toContain('bg-blue-600');

    expect(page.getByRole('button', { name: 'Alpha Channel' })).toBeVisible();
    expect(page.getByRole('button', { name: 'Beta Channel' })).toBeVisible();

    // Both signals visible on /signals (no filter)
    await expect(page.getByText('alpha signal summary')).toBeVisible();
    await expect(page.getByText('beta signal summary')).toBeVisible();

    // Click "Alpha Channel" pill → filters to alpha only
    await page.getByRole('button', { name: 'Alpha Channel' }).click();
    // Wait for HTMX to swap: beta signal disappears from #signals-table
    await expect(page.getByText('beta signal summary')).toBeHidden({ timeout: 5000 });

    await expect(page.getByText('alpha signal summary')).toBeVisible();

    // Alpha pill now blue, All pill gray
    expect(await page.getByRole('button', { name: 'Alpha Channel' }).getAttribute('class')).toContain('bg-blue-600');
    expect(await page.getByRole('button', { name: 'All' }).getAttribute('class')).toContain('bg-gray-200');

    // Click "All" pill → resets filter, both signals back
    await page.getByRole('button', { name: 'All' }).click();
    // Wait for HTMX to swap: beta signal reappears
    await expect(page.getByText('beta signal summary')).toBeVisible({ timeout: 5000 });

    await expect(page.getByText('alpha signal summary')).toBeVisible();
    expect(await allPill.getAttribute('class')).toContain('bg-blue-600');
  });
});
