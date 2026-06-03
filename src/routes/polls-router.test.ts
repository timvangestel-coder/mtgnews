import request from 'supertest';
import express from 'express';
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
      expect(res.text).toContain('bg-green-600');
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
  });
});
