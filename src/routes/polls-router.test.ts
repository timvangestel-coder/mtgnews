import request from 'supertest';
import express from 'express';
import ejsLayouts from 'express-ejs-layouts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';
import { PollQueryService } from '../services/poll-query-service';
import { createPollsRouter } from './polls-router';

let db: Database.Database;
let app: express.Express;

function setupApp(service: PollQueryService) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.set('view engine', 'ejs');
  a.set('views', 'views');
  a.use(ejsLayouts);
  a.get('/', (_req, res) => res.redirect('/signals'));
  a.use(createPollsRouter(service));
  return a;
}

describe('polls-router', () => {
  describe('GET /polls', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new PollQueryService(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 200 with empty state when no runs', async () => {
      const res = await request(app).get('/polls');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Run History');
      expect(res.text).toContain('No poll runs yet');
    });

    it('displays runs with status badges', async () => {
      addChannel(db, 'UCbadge1', 'Badge Ch 1');
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)"
      ).run(1000, 'done', 5, 2000);
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(1, 'UCbadge1', 'done', 3, 1500);

      const res = await request(app).get('/polls');
      expect(res.status).toBe(200);
      expect(res.text).toContain('bg-success-600');
    });

    it('shows new signal count and channel summary', async () => {
      const res = await request(app).get('/polls');
      expect(res.status).toBe(200);
      expect(res.text).toContain('5');
    });

    it('rows link to detail page', async () => {
      const res = await request(app).get('/polls');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/polls/1-detail');
    });
  });

  describe('GET /polls/:id-detail', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      addChannel(db, 'UCdetail1', 'Detail Ch 1');
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)"
      ).run(1000, 'done', 3, 2000);
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(1, 'UCdetail1', 'done', 3, 1500);
      app = setupApp(new PollQueryService(db));
    });

    afterAll(() => {
      db.close();
    });

    it('shows run header and channel breakdown', async () => {
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Run Detail');
      expect(res.text).toContain('Detail Ch 1');
    });

    it('returns 404 for nonexistent run', async () => {
      const res = await request(app).get('/polls/9999-detail');
      expect(res.status).toBe(404);
    });

    it('shows per-channel progress in detail page', async () => {
      // Issue #79: poll-detail shows raw DB data (no phase-based analysis counter)
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 3, 2)"
      ).run(Date.now());
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, 'UCdetail1', 'done', 5, 5, ?)"
      ).run(2, Date.now());

      const res = await request(app).get('/polls/2-detail');
      expect(res.status).toBe(200);
      // Detail page shows signals_found count
      expect(res.text).toContain('5');
    });

    it('shows none badge for channels with 0 signals found', async () => {
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days, phase) VALUES (?, 'running', 3, 2, 'channel_polling')"
      ).run(Date.now());
      // Channel with signals
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'done', 3, ?)"
      ).run(3, 'UCdetail1', Date.now());
      // Channel with ZERO signals — should show "none" not "done"
      addChannel(db, 'UC_none_ch', 'None Ch');
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'done', 0, ?)"
      ).run(3, 'UC_none_ch', Date.now());

      const res = await request(app).get('/polls/3-detail');
      expect(res.status).toBe(200);
      // Zero-signal channel should render "none" with grey styling
      expect(res.text).toContain('none');
    });

    it('uses progress-widget partial instead of inline channel table', async () => {
      // Issue #125: poll-detail uses _pollProgress partial (progress-widget) not inline table
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      // Should contain the progress-widget div from _pollProgress.ejs
      expect(res.text).toContain('progress-widget');
      // Should NOT contain old inline channel table headers
      expect(res.text).not.toContain('Channel Breakdown');
    });

    it('passes progressUrl to partial for HTMX polling target', async () => {
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      // The hx-get should target /polls/1/progress (per-run endpoint)
      expect(res.text).toContain('hx-get="/polls/1/progress"');
    });

    it('does not poll for completed runs', async () => {
      // Issue #125: completed/failed/aborted runs render static (no hx-trigger="every 3s")
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      // Run #1 has status 'done' → mapped to 'complete' → no polling
      expect(res.text).not.toContain('hx-trigger="every 3s"');
    });

    it('preserves header section with triggered_at, status badge, new_signal_count', async () => {
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      // Header elements must still be present
      expect(res.text).toContain('Run Detail');
      expect(res.text).toContain('Triggered');
      expect(res.text).toContain('New Signals');
      expect(res.text).toContain('3'); // new_signal_count
    });

    it('shows step labels from state.steps instead of raw progress table', async () => {
      const res = await request(app).get('/polls/1-detail');
      expect(res.status).toBe(200);
      // Should show channel display name via steps
      expect(res.text).toContain('Detail Ch 1');
    });
  });

  describe('GET /polls/:id/progress', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      addChannel(db, 'UCprog1', 'Progress Ch 1');
      // Run #1: done run
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)"
      ).run(1000, 'done', 3, 2000);
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(1, 'UCprog1', 'done', 3, 1500);
      // Run #2: running run
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
      ).run(Date.now(), 'running', 2);
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(2, 'UCprog1', 'processing', 1, Date.now());
      app = setupApp(new PollQueryService(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns progress widget for a completed run without hx-trigger polling', async () => {
      const res = await request(app).get('/polls/1/progress');
      expect(res.status).toBe(200);
      // Should contain the progress-widget div
      expect(res.text).toContain('progress-widget');
      // Completed run should NOT have hx-trigger="every 3s"
      expect(res.text).not.toContain('hx-trigger="every 3s"');
      // Should show channel data
      expect(res.text).toContain('Progress Ch 1');
    });

    it('returns progress widget for a running run WITH hx-trigger polling', async () => {
      const res = await request(app).get('/polls/2/progress');
      expect(res.status).toBe(200);
      // Should contain the progress-widget div
      expect(res.text).toContain('progress-widget');
      // Running run SHOULD have hx-trigger="every 3s" for live polling
      expect(res.text).toContain('hx-trigger="every 3s"');
      // Should target self for HTMX swap
      expect(res.text).toContain('hx-get="/polls/2/progress"');
    });

    it('returns fallback text when run not found', async () => {
      const res = await request(app).get('/polls/9999/progress');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No poll runs yet');
    });

    it('renders fragment only (no layout wrapper)', async () => {
      const res = await request(app).get('/polls/1/progress');
      expect(res.status).toBe(200);
      // Should NOT contain layout elements like <html>, <body>, or the nav
      expect(res.text).not.toContain('<!DOCTYPE');
      expect(res.text).not.toContain('<html>');
    });

    it('shows running status badge for active runs', async () => {
      const res = await request(app).get('/polls/2/progress');
      expect(res.status).toBe(200);
      expect(res.text).toContain('running');
    });

    it('shows complete status badge for done runs', async () => {
      const res = await request(app).get('/polls/1/progress');
      expect(res.status).toBe(200);
      expect(res.text).toContain('complete');
    });
  });
});
