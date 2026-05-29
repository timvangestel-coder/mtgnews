import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { PollTriggerService } from './poll-trigger-service';

let db: Database.Database;
let service: PollTriggerService;

describe('PollTriggerService', () => {
  describe('enqueueRun', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      service = new PollTriggerService(db);
    });

    afterAll(() => {
      db.close();
    });

    it('creates a poll run with default lookback and returns runId', () => {
      const runId = service.enqueueRun();
      expect(runId).toBeGreaterThan(0);

      const run = db.prepare('SELECT status, lookback_days FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('running');
      expect(run.lookback_days).toBe(2);
    });

    it('creates a poll run with custom lookback days', () => {
      const runId = service.enqueueRun(5);
      expect(runId).toBeGreaterThan(0);

      const run = db.prepare('SELECT lookback_days FROM poll_runs WHERE id = ?').get(runId);
      expect(run.lookback_days).toBe(5);
    });
  });

  describe('abortRun', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      service = new PollTriggerService(db);
    });

    afterAll(() => {
      db.close();
    });

    it('throws when run not found', () => {
      expect(() => service.abortRun(999)).toThrow('not found');
    });

    it('throws when run already aborted', () => {
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'done-forced', 0)").run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      expect(() => service.abortRun(runId)).toThrow('already aborted');
    });

    it('aborts a running poll and sets status to done-forced', () => {
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)").run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      service.abortRun(runId);

      const run = db.prepare('SELECT status, abort_time FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done-forced');
      expect(run.abort_time).toBeDefined();
    });
  });

  describe('currentProgress', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      service = new PollTriggerService(db);
    });

    afterAll(() => {
      db.close();
    });

    it('returns null when no poll runs exist', () => {
      const result = service.currentProgress();
      expect(result).toBeNull();
    });

    it('returns run and progress data when runs exist', () => {
      const runId = service.enqueueRun();

      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, 'UC_test', 'done', 3, Date.now());

      const result = service.currentProgress();
      expect(result).not.toBeNull();
      expect(result!.run.id).toBe(runId);
      expect(result!.progress).toHaveLength(1);
      expect(result!.progress[0].channel_id).toBe('UC_test');
      expect(result!.progress[0].signals_found).toBe(3);
    });
  });
});