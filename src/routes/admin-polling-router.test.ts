import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { PollTriggerService } from '../services/poll-trigger-service';
import { createAdminPollingRouter } from './admin-polling-router';

let db: Database.Database;
let app: express.Express;
let service: PollTriggerService;

function setupApp(svc: PollTriggerService) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.set('view engine', 'ejs');
  a.set('views', 'views');
  a.use(createAdminPollingRouter(svc));
  return a;
}

describe('admin-polling-router', () => {
  describe('POST /admin/poll/trigger', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      service = new PollTriggerService(db);
      app = setupApp(service);
    });

    afterAll(() => {
      db.close();
    });

    it('creates a poll run and returns 204 for HTMX requests', async () => {
      const res = await request(app)
        .post('/admin/poll/trigger')
        .set('HX-Request', 'true')
        .send({});

      expect(res.status).toBe(204);

      const count = (db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number }).c;
      expect(count).toBeGreaterThan(0);
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/poll/trigger')
        .send({});

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
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
      service = new PollTriggerService(db);
      app = setupApp(service);
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
      service = new PollTriggerService(db);
      app = setupApp(service);
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
      const runId = service.enqueueRun();

      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, 'UC_test', 'done', 3, Date.now());

      const res = await request(app).get('/admin/poll/progress');
      expect(res.status).toBe(200);
      // The _pollProgress template renders run status and channel data
      expect(res.text).not.toContain('No poll runs yet');
    });
  });
});