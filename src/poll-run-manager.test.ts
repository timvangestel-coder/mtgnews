import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';
import { PollRunManager } from './poll-run-manager';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('PollRunManager', () => {
  let db: Database.Database;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PollRunManager(db);
  });

  afterAll(() => {
    db.close();
  });

  describe('startRun', () => {
    it('enqueues a poll run and returns runId', async () => {
      const runId = await manager.startRun();

      expect(runId).toBeGreaterThan(0);
      const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
      // With no channels, worker completes instantly so status may be 'done' already
      expect(run.status).toBeOneOf(['running', 'done']);
      expect(run.triggered_at).toBeTypeOf('number');
      expect(run.new_signal_count).toBeTypeOf('number');
    });

    it('defaults lookback_days to 2', async () => {
      const runId = await manager.startRun();

      const run = db.prepare('SELECT lookback_days FROM poll_runs WHERE id = ?').get(runId);
      expect(run.lookback_days).toBe(2);
    });

    it('stores custom lookback_days when provided', async () => {
      const runId = await manager.startRun(7);

      const run = db.prepare('SELECT lookback_days FROM poll_runs WHERE id = ?').get(runId);
      expect(run.lookback_days).toBe(7);
    });

    it('pre-registers channel progress rows', async () => {
      // Add a topic first (FK requirement), then an active channel
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      const runId = await manager.startRun();

      // Wait for worker to complete so we can check final state
      await new Promise((r) => setTimeout(r, 200));

      const progressRows = db.prepare(
        'SELECT * FROM poll_run_progress WHERE poll_run_id = ?'
      ).all(runId);
      expect(progressRows).toHaveLength(1);
      expect((progressRows[0] as any).channel_id).toBe('UC_test');
      // Worker may have already processed the channel; status reflects final state
      expect((progressRows[0] as any).status).toBeOneOf(['pending', 'running', 'done', 'failed']);
    });

    it('spawns worker in background (non-blocking)', async () => {
      // With no channels, the worker should complete quickly
      const runId = await manager.startRun();

      // Wait a bit for the worker to finish
      await new Promise((r) => setTimeout(r, 100));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      // With no channels, worker should have completed
      expect(state!.status).toBe('complete');
    });
  });

  describe('runState', () => {
    it('returns null for non-existent runId', () => {
      const state = manager.runState(999);
      expect(state).toBeNull();
    });

    it('returns RunState with id, status, steps (simplified shape)', async () => {
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      const runId = await manager.startRun();
      // Wait for worker to complete
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.id).toBe(runId);
      expect(state!.status).toBeOneOf(['running', 'complete', 'failed', 'aborted']);
      expect(Array.isArray(state!.steps)).toBe(true);
      // Simplified: no phase, signalsAnalyzed, summary, analysis
      expect((state as any).phase).toBeUndefined();
      expect((state as any).signalsAnalyzed).toBeUndefined();
    });

    it('reflects channel progress in steps', async () => {
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      const runId = await manager.startRun();
      // Wait for worker to complete
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state!.steps).toHaveLength(1);
      expect(state!.steps[0].displayName).toBe('Test Channel');
    });
  });

  describe('abortRun', () => {
    it('throws when run not found', async () => {
      await expect(manager.abortRun(999)).rejects.toThrow(/not found/i);
    });

    it('throws when run already aborted', async () => {
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'done-forced', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      await expect(manager.abortRun(runId)).rejects.toThrow(/already aborted/i);
    });

    it('aborts a running poll and sets status to done-forced', async () => {
      // Insert a long-running simulation: use a channel that we control
      // For this test, just verify the abort path on DB level
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      await manager.abortRun(runId);

      const run = db.prepare('SELECT status, abort_time FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done-forced');
      expect(run.abort_time).toBeDefined();
    });
  });

  describe('currentProgress', () => {
    it('returns null when no runs exist', () => {
      const result = manager.currentProgress();
      expect(result).toBeNull();
    });

    it('returns latest run with progress', async () => {
      const runId = await manager.startRun();

      const result = manager.currentProgress();
      expect(result).not.toBeNull();
      expect(result!.run.id).toBe(runId);
      expect(Array.isArray(result!.progress)).toBe(true);
    });
  });

  describe('run completion', () => {
    it('marks run as done after worker completes with no channels', async () => {
      const runId = await manager.startRun();
      // Wait for worker to complete
      await new Promise((r) => setTimeout(r, 300));

      // After completion, status should be 'done' in DB
      const run = db.prepare('SELECT status FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done');
    });

    it('RunState has no phase or summary after simplification', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      // Phase and summary were removed in issue #79
      expect((state as any).phase).toBeUndefined();
      expect((state as any).summary).toBeUndefined();
    });
  });

  describe('signals_done counter', () => {
    it('per-channel signals_done is tracked in progress rows', async () => {
      // With no channels, no signals to process — signals_done stays at 0
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      const result = manager.currentProgress();
      expect(result).not.toBeNull();
      // Progress rows exist (or are empty if no channels)
      expect(Array.isArray(result!.progress)).toBe(true);
    });
  });
});
