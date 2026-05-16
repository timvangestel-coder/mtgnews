import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from './init-db';
import { addChannel } from './watchlist';
import { queryPollRuns, getPollRunById, queryPollRunProgress } from './poll-runs';

let db: Database.Database;

describe('poll-runs DB queries', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
  });

  afterAll(() => {
    db.close();
  });

  describe('queryPollRuns', () => {
    it('returns empty when no runs exist', () => {
      const result = queryPollRuns(db);
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    it('returns runs sorted newest first with channel stats', () => {
      addChannel(db, 'UC1', 'Channel 1');
      addChannel(db, 'UC2', 'Channel 2');

      // run 1 (older)
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(1000, 'done', 3, 2000);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(1, 'UC1', 'done', 2, 1500);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(1, 'UC2', 'done', 1, 1600);

      // run 2 (newer)
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(3000, 'done', 1, 4000);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(2, 'UC1', 'done', 1, 3500);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(2, 'UC2', 'failed', 0, 3600);

      const result = queryPollRuns(db);
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe(2); // newest first
      expect(result.items[0].channels_done).toBe(1);
      expect(result.items[0].channels_failed).toBe(1);
      expect(result.items[0].channels_total).toBe(2);
      expect(result.items[1].channels_done).toBe(2);
      expect(result.items[1].channels_failed).toBe(0);
    });

    it('respects pagination limit and offset', () => {
      // add more runs
      for (let i = 3; i <= 10; i++) {
        db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(i * 1000, 'done', 0);
      }

      const result = queryPollRuns(db, { limit: 3, offset: 0 });
      expect(result.total).toBe(10);
      expect(result.items).toHaveLength(3);
    });

    it('returns page 2 with correct offset', () => {
      const result = queryPollRuns(db, { limit: 3, offset: 3 });
      expect(result.items).toHaveLength(3);
    });
  });

  describe('getPollRunById', () => {
    it('returns null for nonexistent id', () => {
      expect(getPollRunById(db, 999)).toBeNull();
    });

    it('returns run with channel stats', () => {
      const run = getPollRunById(db, 1);
      expect(run).not.toBeNull();
      expect(run!.id).toBe(1);
      expect(run!.status).toBe('done');
      expect(run!.new_signal_count).toBe(3);
      expect(run!.channels_done).toBe(2);
    });
  });

  describe('queryPollRunProgress', () => {
    it('returns empty array for run with no progress', () => {
      db.prepare("INSERT INTO poll_runs (triggered_at, status) VALUES (?, ?)").run(9000, 'running');
      const progress = queryPollRunProgress(db, 999);
      expect(progress).toHaveLength(0);
    });

    it('returns per-channel progress with display names', () => {
      const progress = queryPollRunProgress(db, 1);
      expect(progress).toHaveLength(2);
      expect(progress[0].channel_id).toBe('UC1');
      expect(progress[0].display_name).toBe('Channel 1');
      expect(progress[0].status).toBe('done');
      expect(progress[0].signals_found).toBe(2);
    });
  });
});