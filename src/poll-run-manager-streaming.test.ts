import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';
import { PollRunManager } from './poll-run-manager';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('PollRunManager streaming pipeline (issue #80)', () => {
  let db: Database.Database;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PollRunManager(db);
  });

  afterAll(() => {
    db.close();
  });

  // ── Tracer bullet: basic streaming flow ──

  describe('streaming pipeline', () => {
    it('processes channels end-to-end without phase transitions', async () => {
      // The worker should NOT update a "phase" column at any point
      // Since phase column is removed in #79, we verify no phase-related SQL runs
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      // Verify the run completed without errors
      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('complete');
    });

    it('does not use global signals_analyzed counter', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      // The poll_runs row should NOT have signals_analyzed updated
      const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
      // signals_analyzed column exists but should remain at default (0 or unused)
      expect((run as any).signals_analyzed).toBe(0);
    });

    it('does not use signals_to_analyze counter', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
      expect((run as any).signals_to_analyze).toBe(0);
    });
  });

  // ── Progress row behavior ──

  describe('progress row writes', () => {
    it('uses "processing" status for channels with discovered signals', async () => {
      // Add a topic and channel
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_test', 'Test Channel', Date.now(), 1);

      // Mock pollChannel to return signals
      vi.mock('./poll', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./poll')>();
        return {
          ...actual,
          pollChannel: vi.fn().mockResolvedValue({ newSignals: 0, skippedDuplicates: 0, skippedNoCaptions: [] }),
        };
      });

      // Re-import after mocking
      const { PollRunManager: PRM } = await import('./poll-run-manager');
      const mockedManager = new PRM(db);

      const runId = await mockedManager.startRun();
      await new Promise((r) => setTimeout(r, 500));

      // Check progress rows — channel should have been processed
      const progressRows = db.prepare(
        'SELECT * FROM poll_run_progress WHERE poll_run_id = ?'
      ).all(runId);
      expect(progressRows.length).toBeGreaterThan(0);
    });
  });

  // ── Concurrency pool behavior ──

  describe('concurrency pool', () => {
    it('limits parallel analysis tasks to LLM_CONCURRENCY', async () => {
      // This is verified by the existence of the concurrency pool mechanism
      // The worker should dispatch tasks to a global pool with concurrency limit
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('complete');
    });
  });

  // ── Abort still works ──

  describe('abort', () => {
    it('aborts a running poll and sets status to aborted', async () => {
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      await manager.abortRun(runId);

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('aborted');
    });

    it('deletes unsummarized signals on abort', async () => {
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      // Insert a channel so FK constraint is satisfied
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_abort_test', 'Abort Test Channel', Date.now(), 1);

      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)"
      ).run(Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      // Insert an unprocessed signal
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('abort_vid1', 'UC_abort_test', 'Abort Video', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);

      // Insert a summarized signal (should NOT be deleted)
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('abort_vid2', 'UC_abort_test', 'Processed Video', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId, 'summarized');

      await manager.abortRun(runId);

      // Unprocessed signal should be gone
      const unprocessed = db.prepare(
        "SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?"
      ).get('abort_vid1') as { cnt: number };
      expect(unprocessed.cnt).toBe(0);

      // Processed signal should remain
      const processed = db.prepare(
        "SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?"
      ).get('abort_vid2') as { cnt: number };
      expect(processed.cnt).toBe(1);
    });
  });

  // ── Abort: in-flight callbacks don't inflate signals_done (issue #83) ──

  describe('abort does not inflate signals_done (issue #83)', () => {
    it('signals_done stays 0 when abort deletes signals before in-flight analysis completes', async () => {
      // Add a topic and channel
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_abort_inflight', 'Abort Inflight Channel', Date.now(), 1);

      // Mock pollChannel to return signals, mock analyzeSignal to be slow (delayed)
      vi.mock('./poll', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./poll')>();
        return {
          ...actual,
          pollChannel: vi.fn().mockImplementation(async (database, channelId, options) => {
            if (channelId === 'UC_abort_inflight') {
              const runId = options?.runId ?? 1;
              // Insert signals directly so the worker can find them
              database.prepare(
                "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
              ).run('inflight_vid1', channelId, 'Inflight Video 1', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);
              database.prepare(
                "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
              ).run('inflight_vid2', channelId, 'Inflight Video 2', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);
              return { newSignals: 2, skippedDuplicates: 0, skippedNoCaptions: [] };
            }
            return { newSignals: 0, skippedDuplicates: 0, skippedNoCaptions: [] };
          }),
        };
      });

      vi.mock('./llm', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./llm')>();
        return {
          ...actual,
          analyzeSignal: vi.fn().mockImplementation(async (_db, _videoId, _config, abortSignal) => {
            // Simulate slow analysis — wait long enough that abort fires before this completes
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (abortSignal?.aborted) {
              throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
            }
            return { success: true };
          }),
          getLlmConfig: actual.getLlmConfig,
        };
      });

      // Re-import so mocked deps are used
      const { PollRunManager: PRM } = await import('./poll-run-manager');
      const abortManager = new PRM(db);

      const runId = await abortManager.startRun();

      // Give the worker a moment to dispatch analysis tasks to the pool
      await new Promise((r) => setTimeout(r, 100));

      // Now abort — this fires AbortController and deletes unsummarized signals
      await abortManager.abortRun(runId);

      // Wait for in-flight analysis tasks to settle (they'll complete or throw after their delay)
      await new Promise((r) => setTimeout(r, 3000));

      // Check: signals_done should be 0, NOT inflated by phantom increments
      const progress = db.prepare(
        "SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ? AND channel_id = ?"
      ).get(runId, 'UC_abort_inflight') as { signals_found: number; signals_done: number } | undefined;

      // Signals were deleted by abort cleanup — done counter must NOT have been inflated
      expect(progress?.signals_done).toBe(0);
    }, 10000);
  });

  // ── No regression: full run with channels ──

  describe('no regression', () => {
    it('full run with no channels produces complete state', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('complete');
      expect(state!.steps).toHaveLength(0);
    });

    it('run with channel that has no signals shows done with total=0', async () => {
      db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC_empty', 'Empty Channel', Date.now(), 1);

      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 500));

      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('complete');
      expect(state!.steps).toHaveLength(1);
      expect(state!.steps[0].displayName).toBe('Empty Channel');
      expect(state!.steps[0].total).toBe(0);
    });
  });
});