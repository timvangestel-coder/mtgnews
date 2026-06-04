import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { PollRunManager } from './poll-run-manager';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('PollRunManager simplified RunState (issue #79)', () => {
  let db: Database.Database;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PollRunManager(db);
  });

  afterAll(() => {
    db.close();
  });

  describe('PollRunStep interface', () => {
    it('has displayName, status, total, done — no channelId, signalsFound, signalsDone', async () => {
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.steps).toHaveLength(1);

      const step = state!.steps[0];
      // New shape
      expect(step.displayName).toBeDefined();
      expect(typeof step.status).toBe('string');
      expect(typeof step.total).toBe('number');
      expect(typeof step.done).toBe('number');
      // Old fields must NOT exist
      expect((step as any).channelId).toBeUndefined();
      expect((step as any).signalsFound).toBeUndefined();
      expect((step as any).signalsDone).toBeUndefined();
    });

    it('uses "processing" status instead of "running"', async () => {
      // Insert a run with a progress row in 'running' state (DB level)
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      // Manually insert a running poll run with progress to test mapping
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'running', 0, ?)"
      ).run(runId, 'UC_test', Date.now());

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      // The step status should be mapped to 'processing' (not 'running')
      expect(state!.steps[0].status).toBe('processing');
    });
  });

  describe('RunState interface', () => {
    it('only has id, status, steps — no phase, signalsAnalyzed, summary, analysis', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();

      // Required fields exist
      expect(state!.id).toBeDefined();
      expect(typeof state!.status).toBe('string');
      expect(Array.isArray(state!.steps)).toBe(true);

      // Old fields must NOT exist
      expect((state as any).phase).toBeUndefined();
      expect((state as any).signalsAnalyzed).toBeUndefined();
      expect((state as any).summary).toBeUndefined();
      expect((state as any).analysis).toBeUndefined();
    });
  });

  describe('DB query columns', () => {
    it('PollRunRow does not include phase, signals_analyzed, signals_to_analyze', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));

      // Check what currentProgress returns (exposes raw DB rows)
      const result = manager.currentProgress();
      expect(result).not.toBeNull();

      const row = result!.run;
      // Old columns must NOT be on the returned row
      expect((row as any).phase).toBeUndefined();
      expect((row as any).signals_analyzed).toBeUndefined();
      expect((row as any).signals_to_analyze).toBeUndefined();
    });
  });

  describe('5-branch step display logic data', () => {
    it('fetching step has status "fetching"', async () => {
      // Manually insert a run with a fetching progress row to test the mapping
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'fetching', 0, ?)"
      ).run(runId, 'UC_test', Date.now());

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.steps[0].status).toBe('fetching');
    });

    it('done step with total=0 shows "none" semantically (total is 0)', async () => {
      // Channel with no signals: after worker completes, status='done', total=0
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      // Channel had no signals → total=0
      expect(state!.steps[0].total).toBe(0);
    });

    it('failed step has status "failed"', async () => {
      // Manually insert a failed progress row
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, 'failed', 0, ?)"
      ).run(runId, 'UC_test', Date.now());

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.steps[0].status).toBe('failed');
    });
  });

  describe('no regression in abort display', () => {
    it('aborted run has status "aborted"', async () => {
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      await manager.abortRun(runId);

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('aborted');
    });
  });

  describe('no regression in completed run display', () => {
    it('completed run has status "complete"', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('complete');
    });
  });
});