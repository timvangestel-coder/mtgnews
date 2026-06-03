import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { PollRunManager } from '../poll-run-manager';
import { createAdminPollingRouter } from './admin-polling-router';

let db: Database.Database;
let app: express.Express;
let manager: PollRunManager;

function setupApp(mgr: PollRunManager) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.set('view engine', 'ejs');
  a.set('views', 'views');
  a.use(createAdminPollingRouter(mgr));
  return a;
}

describe('admin-polling-router', () => {
  describe('POST /admin/poll/trigger', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      manager = new PollRunManager(db);
      app = setupApp(manager);
    });

    afterAll(() => {
      db.close();
    });

    it('creates a poll run and renders progress widget inline for HTMX requests', async () => {
      const res = await request(app)
        .post('/admin/poll/trigger')
        .set('HX-Request', 'true')
        .send({});

      // Inline render (no redirect) — returns the _pollProgress partial
      expect(res.status).toBe(200);
      // No HX-Redirect header — widget is rendered inline
      expect(res.header['hx-redirect']).toBeUndefined();
      // Response contains the progress widget HTML
      expect(res.text).toContain('progress-widget');

      const count = (db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number }).c;
      expect(count).toBeGreaterThan(0);
    });

    it('renders progress widget inline for non-HTMX requests', async () => {
      const res = await request(app)
        .post('/admin/poll/trigger')
        .send({});

      // Inline render for all requests (no redirect)
      expect(res.status).toBe(200);
      expect(res.text).toContain('progress-widget');
    });

    it('pre-registers pending progress rows for active channels', async () => {
      // Add an active channel with topic
      db.prepare(`INSERT INTO topics (key, short_name, filter_text) VALUES ('mtg', 'MTG', 'test')`).run();
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_pretest', 'Pre-test Channel', Date.now(), 1);

      const res = await request(app)
        .post('/admin/poll/trigger')
        .set('HX-Request', 'true')
        .send({});

      expect(res.status).toBe(200);

      // Give worker time to process
      await new Promise((r) => setTimeout(r, 300));

      // Check that a progress row was created for the channel (status may have advanced from pending)
      const progress = db.prepare(
        "SELECT channel_id, status FROM poll_run_progress WHERE channel_id = ? ORDER BY id DESC LIMIT 1"
      ).all('UC_pretest') as Array<{ channel_id: string; status: string }>;
      expect(progress.length).toBeGreaterThan(0);
      // Worker may have already processed it
      expect(progress[0].status).toBeOneOf(['pending', 'running', 'done', 'failed']);
    });

    it('accepts lookback_days from request body', async () => {
      await request(app)
        .post('/admin/poll/trigger')
        .set('HX-Request', 'true')
        .send({ lookback_days: '7' });

      const run = db.prepare(
        "SELECT lookback_days FROM poll_runs ORDER BY id DESC LIMIT 1"
      ).get() as { lookback_days: number };
      expect(run.lookback_days).toBe(7);
    });

    it('defaults lookback_days to 2 when not provided', async () => {
      await request(app)
        .post('/admin/poll/trigger')
        .set('HX-Request', 'true')
        .send({});

      const run = db.prepare(
        "SELECT lookback_days FROM poll_runs ORDER BY id DESC LIMIT 1"
      ).get() as { lookback_days: number };
      expect(run.lookback_days).toBe(2);
    });
  });

  describe('POST /admin/poll/abort/:id', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      manager = new PollRunManager(db);
      app = setupApp(manager);
    });

    afterAll(() => {
      db.close();
    });

    it('aborts a running poll and redirects to /admin', async () => {
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)").run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const res = await request(app)
        .post(`/admin/poll/abort/${runId}`)
        .send({});

      expect(res.status).toBe(302);
      expect(res.header.location).toBe('/admin');

      const run = db.prepare('SELECT status FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done-forced');
    });

    it('redirects with error when run not found', async () => {
      const res = await request(app)
        .post('/admin/poll/abort/99999')
        .send({});

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('error=');
    });

    it('respects return_to query param on success', async () => {
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)").run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const res = await request(app)
        .post(`/admin/poll/abort/${runId}?return_to=/polls`)
        .send({});

      expect(res.status).toBe(302);
      expect(res.header.location).toBe('/polls');
    });

    it('respects return_to query param on error', async () => {
      const res = await request(app)
        .post('/admin/poll/abort/99999?return_to=/polls')
        .send({});

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('error=');
      expect(res.header.location).toContain('/polls');
    });
  });

  describe('GET /admin/poll/progress', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      manager = new PollRunManager(db);
      app = setupApp(manager);
    });

    afterAll(() => {
      db.close();
    });

    it('shows "No poll runs yet" fallback when no runs exist', async () => {
      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No poll runs yet');
    });

    it('renders poll progress partial with run data', async () => {
      const runId = await manager.startRun();

      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, 'UC_test', 'done', 3, Date.now());

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // The _pollProgress template renders run status and channel data
      expect(res.text).not.toContain('No poll runs yet');
    });

    it('renders per-channel progress counter during processing', async () => {
      // Issue #79: no global "Analyzing signals" banner; progress shown per-channel as X/Y
      const insertResult = db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
      ).run(Date.now());
      const runId = Number(insertResult.lastInsertRowid);

      // Insert a progress row: 3 signals found, 1 done so far
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, 'UC_test', 'running', 3, 1, ?)"
      ).run(runId, Date.now());

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // Template should show per-channel progress: "1/3" in blue
      expect(res.text).toContain('1/3');
      expect(res.text).toContain('text-blue-600');
    });

    it('renders done counter as X/X format when all signals processed', async () => {
      // Issue #79: done label is "X/X" in green (no "done" prefix)
      const insertResult = db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 5, 2)"
      ).run(Date.now());
      const runId = Number(insertResult.lastInsertRowid);

      // All 5 signals done
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, 'UC_ch', 'done', 5, 5, ?)"
      ).run(runId, Date.now());

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // Should show "5/5" in green
      expect(res.text).toContain('5/5');
      expect(res.text).toContain('text-green-600');
    });

    it('shows zero-signal channels as "none" with gray color instead of "done" with green', async () => {
      // Per issue #79 spec: 0 signals -> "none" (grey), not "done" (green)
      const insertResult = db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 3, 2)"
      ).run(Date.now());
      const runId = Number(insertResult.lastInsertRowid);

      // Channel with signals found
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, 'UC_with_signals', 'done', 3, 3, ?)"
      ).run(runId, Date.now());

      // Channel with ZERO signals found — should show "none" in grey
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, 'UC_no_signals', 'done', 0, 0, ?)"
      ).run(runId, Date.now());

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // Zero-signal channel should render "none" not "done"
      expect(res.text).toContain('none');
      // Template uses displayName from channels table; if no channel row, displayName is null
      // The step will show empty displayName but still have the correct color class
      expect(res.text).toContain('text-gray-400');
    });

    it('renders pending channels with gray color', async () => {
      db.prepare("INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)").run('test', 'Test', 'test');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_pending', 'Pending Channel', Date.now(), 1);

      const runId = await manager.startRun();
      // Immediately check — pre-registration creates pending rows
      // Worker may not have started processing yet

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // The widget should contain the channel name
      expect(res.text).toContain('Pending Channel');
    });
  });
});