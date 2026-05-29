import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';
import { PollQueryService } from './poll-query-service';

let db: Database.Database;
let service: PollQueryService;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  service = new PollQueryService(db);
});

afterAll(() => {
  db.close();
});

describe('PollQueryService', () => {
  describe('listRuns()', () => {
    it('returns empty list when no poll runs exist', () => {
      const result = service.listRuns(1, 25);
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns all runs ordered by triggered_at DESC within time window', () => {
      const t = Date.now();
      addChannel(db, `UClistruns${t}`, 'List Runs Ch');

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(t + 1000, 'done', 3, t + 2000);
      const id1 = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(id1, `UClistruns${t}`, 'done', 3, t + 1500);

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(t + 3000, 'done', 1, t + 4000);
      const id2 = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(id2, `UClistruns${t}`, 'done', 1, t + 3500);

      // Count only runs in our time window
      const totalInWindow = (db.prepare('SELECT COUNT(*) as c FROM poll_runs WHERE triggered_at >= ?').get(t) as { c: number }).c;
      const result = service.listRuns(1, 25);
      expect(result.items.filter(r => r.triggered_at >= t).length).toBe(totalInWindow);
      // Most recent first among our runs
      const ours = result.items.filter(r => r.triggered_at >= t);
      expect(ours[0].triggered_at).toBe(t + 3000);
      expect(ours[1].triggered_at).toBe(t + 1000);
    });

    it('respects pagination limit and offset', () => {
      const result = service.listRuns(1, 3);
      // Limit caps items returned
      expect(result.items.length).toBeLessThanOrEqual(3);
    });

    it('returns correct page with offset', () => {
      const page1 = service.listRuns(1, 3);
      const page2 = service.listRuns(2, 3);
      // Page 2 items should have different IDs than page 1 (or be empty if fewer total)
      const page1Ids = new Set(page1.items.map(i => i.id));
      for (const item of page2.items) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
    });
  });

  describe('getRunDetail()', () => {
    it('returns null for nonexistent run', () => {
      const result = service.getRunDetail(-1);
      expect(result).toBeNull();
    });

    it('returns run with progress rows', () => {
      const t = Date.now();
      addChannel(db, `UCdetailruns${t}`, 'Detail Runs Ch');

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(t + 1000, 'done', 3, t + 2000);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(runId, `UCdetailruns${t}`, 'done', 2, t + 1500);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(runId, `UCdetailruns${t}`, 'failed', 1, t + 1600);

      const result = service.getRunDetail(runId);
      expect(result).not.toBeNull();
      expect(result!.run.id).toBe(runId);
      expect(result!.run.status).toBe('done');
      // Only count progress rows for this specific run
      expect(result!.progress.length).toBe(2);
    });

    it('includes channel display_name in progress rows', () => {
      const t = Date.now();
      addChannel(db, `UCnamed${t}`, 'Named Channel');

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(t + 1000, 'running', 0);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(runId, `UCnamed${t}`, 'done', 1, t + 1500);

      const result = service.getRunDetail(runId);
      expect(result).not.toBeNull();
      expect(result!.progress.length).toBe(1);
      expect(result!.progress[0].display_name).toBe('Named Channel');
    });

    it('returns empty progress when no progress rows exist', () => {
      const t = Date.now();
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(t + 5000, 'running', 0);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const result = service.getRunDetail(runId);
      expect(result).not.toBeNull();
      expect(result!.progress).toEqual([]);
    });
  });
});