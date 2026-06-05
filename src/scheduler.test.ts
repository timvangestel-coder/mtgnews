import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { recoverStaleRuns, startScheduledPolling, stopScheduledPolling } from './scheduler';
import { PollRunManager } from './poll-run-manager';
import { createTestDb } from '../tests/fixtures/test-db';

// vi.mock hoists to top -> define mock fn inside factory
vi.mock('node-cron', () => {
  const mockSchedule = vi.fn((_, fn) => {
    (global as any).__mockCronFn = fn;
    return { stop: vi.fn() };
  });
  return {
    default: {
      schedule: mockSchedule,
    },
  };
});

describe('scheduler', () => {
  let db: Database.Database;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PollRunManager(db);
    vi.clearAllMocks();
  });

  afterAll(() => {
    stopScheduledPolling();
    db.close();
  });

  it('starts cron job that enqueues poll runs', async () => {
    startScheduledPolling(manager);

    const cronFn = (global as any).__mockCronFn;
    expect(cronFn).toBeDefined();
    await cronFn();

    // Give the async startRun time to complete
    await new Promise((r) => setTimeout(r, 50));

    const runs = db.prepare('SELECT * FROM poll_runs').all();
    expect(runs).toHaveLength(1);
    // With no channels, worker completes instantly so status may be 'done'
    expect(runs[0].status).toBeOneOf(['running', 'done']);
  });

  it('calls cron.schedule on start', () => {
    startScheduledPolling(manager);
    const cronFn = (global as any).__mockCronFn;
    expect(cronFn).toBeTypeOf('function');
  });

  describe('recoverStaleRuns', () => {
    it('deletes poll_run_progress rows before deleting a stale run with no signals', () => {
      // Insert a stale running poll_run
      db.prepare(
        "INSERT INTO poll_runs (id, triggered_at, status) VALUES (?, ?, 'running')"
      ).run(1, Date.now());

      // Pre-register progress rows (as happens during normal polling)
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at) VALUES (?, ?, 1, ?)"
      ).run('UCfake1', 'Fake Channel 1', Date.now());
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at) VALUES (?, ?, 1, ?)"
      ).run('UCfake2', 'Fake Channel 2', Date.now());

      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'pending', 0, ?)"
      ).run(1, 'UCfake1', Date.now());
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'pending', 0, ?)"
      ).run(1, 'UCfake2', Date.now());

      // No signals at all for this run

      // This should NOT throw a FOREIGN KEY constraint error
      expect(() => recoverStaleRuns(db)).not.toThrow();

      const runs = db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number };
      expect(runs.c).toBe(0);

      const progress = db.prepare('SELECT COUNT(*) as c FROM poll_run_progress').get() as { c: number };
      expect(progress.c).toBe(0);
    });

    it('keeps a stale run as done-forced when processed signals exist', () => {
      // Insert a stale running poll_run
      db.prepare(
        "INSERT INTO poll_runs (id, triggered_at, status) VALUES (?, ?, 'running')"
      ).run(2, Date.now());

      // Insert a processed signal for this run
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at) VALUES (?, ?, 1, ?)"
      ).run('UCfake3', 'Fake Channel 3', Date.now());

      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at, processing_state, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('vid123', 'UCfake3', 'Test Video', 'transcript', Date.now(), 'summarized', 2);

      // Insert progress rows
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'done', 1, ?)"
      ).run(2, 'UCfake3', Date.now());

      expect(() => recoverStaleRuns(db)).not.toThrow();

      const run = db.prepare(
        "SELECT * FROM poll_runs WHERE id = ?"
      ).get(2);
      expect(run).toBeDefined();
      expect((run as any).status).toBe('done-forced');
    });
  });
});
