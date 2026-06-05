import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollRunManager } from './poll-run-manager';
import { queryPollRunProgress, preRegisterChannelProgress } from './db/poll-runs';
import { createTestDb } from '../tests/fixtures/test-db';

describe('PollRunManager', () => {
  let db: Database.Database;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PollRunManager(db);
  });

  afterAll(() => db.close());

  function seedTopic(id: number = 1, key: string = 'tech') {
    db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(id, key, key, key);
  }
  function seedChannel(channelId: string, displayName: string | null, topicId: number = 1) {
    db.prepare("INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)").run(channelId, displayName, Date.now(), topicId);
  }
  function seedRun(status: string = 'running', newSignalCount: number = 0): number {
    db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(Date.now(), status, newSignalCount);
    return (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
  }
  function seedProgress(runId: number, channelId: string, status: string, signalsFound: number, signalsDone: number = 0) {
    db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(runId, channelId, status, signalsFound, signalsDone, Date.now());
  }
  function seedSignal(videoId: string, channelId: string, runId: number, processingState: string = 'pending') {
    db.prepare("INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(videoId, channelId, `Video ${videoId}`, new Date().toISOString(), '[]', Date.now(), runId, processingState);
  }

  describe('fetching state', () => {
    it('preRegisterChannelProgress inserts "fetching" status', () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = seedRun();
      preRegisterChannelProgress(db, runId);
      expect(db.prepare('SELECT status FROM poll_run_progress WHERE poll_run_id = ?').get(runId).status).toBe('fetching');
    });

    it('runState maps "fetching" DB status to "fetching" step status', () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = seedRun();
      seedProgress(runId, 'UC_test', 'fetching', 0);
      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.steps[0].status).toBe('fetching');
    });
  });

  describe('channel ordering', () => {
    it('returns progress rows in alphabetical order by display_name', () => {
      seedTopic();
      seedChannel('UC_z', 'Zen van Riel');
      seedChannel('UC_a', 'Tech News Daily');
      seedChannel('UC_m', 'Two Minute Papers');
      const runId = seedRun();
      preRegisterChannelProgress(db, runId);
      expect(queryPollRunProgress(db, runId).map(p => p.display_name)).toEqual(['Tech News Daily', 'Two Minute Papers', 'Zen van Riel']);
    });

    it('places NULL display_name first in alphabetical order', () => {
      seedTopic();
      seedChannel('UC_null', null);
      seedChannel('UC_a', 'Alpha Channel');
      const runId = seedRun();
      preRegisterChannelProgress(db, runId);
      const progress = queryPollRunProgress(db, runId);
      expect(progress[0].display_name).toBeNull();
      expect(progress[1].display_name).toBe('Alpha Channel');
    });
  });

  describe('startRun', () => {
    it('enqueues a poll run and returns runId', async () => {
      const runId = await manager.startRun();
      expect(runId).toBeGreaterThan(0);
      expect(db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId).status).toBeOneOf(['running', 'done']);
    });

    it('defaults lookback_days to 2', async () => {
      const runId = await manager.startRun();
      expect(db.prepare('SELECT lookback_days FROM poll_runs WHERE id = ?').get(runId).lookback_days).toBe(2);
    });

    it('stores custom lookback_days when provided', async () => {
      const runId = await manager.startRun(7);
      expect(db.prepare('SELECT lookback_days FROM poll_runs WHERE id = ?').get(runId).lookback_days).toBe(7);
    });

    it('pre-registers channel progress rows', async () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));
      const rows = db.prepare('SELECT * FROM poll_run_progress WHERE poll_run_id = ?').all(runId);
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).channel_id).toBe('UC_test');
    });

    it('spawns worker in background (non-blocking)', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 100));
      expect(manager.runState(runId)!.status).toBe('complete');
    });
  });

  describe('runState', () => {
    it('returns null for non-existent runId', () => {
      expect(manager.runState(999)).toBeNull();
    });

    it('returns RunState with id, status, steps (simplified shape)', async () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));
      const state = manager.runState(runId);
      expect(state).not.toBeNull();
      expect(state!.id).toBe(runId);
      expect(state!.status).toBeOneOf(['running', 'complete', 'failed', 'aborted']);
      expect(Array.isArray(state!.steps)).toBe(true);
      expect((state as any).phase).toBeUndefined();
    });

    it('reflects channel progress in steps', async () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 200));
      expect(manager.runState(runId)!.steps).toHaveLength(1);
    });
  });

  describe('abortRun', () => {
    it('throws when run not found', async () => {
      await expect(manager.abortRun(999)).rejects.toThrow(/not found/i);
    });

    it('throws when run already aborted', async () => {
      seedRun('done-forced');
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;
      await expect(manager.abortRun(runId)).rejects.toThrow(/already aborted/i);
    });

    it('aborts a running poll and sets status to done-forced', async () => {
      const runId = seedRun();
      await manager.abortRun(runId);
      const run = db.prepare('SELECT status, abort_time FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done-forced');
      expect(run.abort_time).toBeDefined();
    });
  });

  describe('currentProgress', () => {
    it('returns null when no runs exist', () => {
      expect(manager.currentProgress()).toBeNull();
    });

    it('returns latest run with progress', async () => {
      const runId = await manager.startRun();
      const result = manager.currentProgress();
      expect(result).not.toBeNull();
      expect(result!.run.id).toBe(runId);
    });
  });

  describe('run completion', () => {
    it('marks run as done after worker completes with no channels', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      expect(db.prepare('SELECT status FROM poll_runs WHERE id = ?').get(runId).status).toBe('done');
    });

    it('RunState has no phase or summary after simplification', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      const state = manager.runState(runId);
      expect((state as any).phase).toBeUndefined();
      expect((state as any).summary).toBeUndefined();
    });
  });

  describe('streaming pipeline', () => {
    it('processes channels end-to-end without phase transitions', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      expect(manager.runState(runId)!.status).toBe('complete');
    });

    it('does not use global signals_analyzed counter', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      expect(db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId).signals_analyzed).toBe(0);
    });

    it('does not use signals_to_analyze counter', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      expect(db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId).signals_to_analyze).toBe(0);
    });

    it('run with channel that has no signals shows done with total=0', async () => {
      seedTopic(); seedChannel('UC_empty', 'Empty Channel');
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 500));
      const state = manager.runState(runId);
      expect(state!.status).toBe('complete');
      expect(state!.steps[0].displayName).toBe('Empty Channel');
      expect(state!.steps[0].total).toBe(0);
    });

    it('full run with no channels produces complete state', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      const state = manager.runState(runId);
      expect(state!.status).toBe('complete');
      expect(state!.steps).toHaveLength(0);
    });
  });

  describe('abort integration', () => {
    it('aborts a running poll and maps to aborted status', async () => {
      const runId = seedRun();
      await manager.abortRun(runId);
      expect(manager.runState(runId)!.status).toBe('aborted');
    });

    it('deletes unsummarized signals on abort', async () => {
      seedTopic(); seedChannel('UC_abort_test', 'Abort Test Channel');
      const runId = seedRun();
      seedSignal('abort_vid1', 'UC_abort_test', runId, 'pending');
      seedSignal('abort_vid2', 'UC_abort_test', runId, 'summarized');
      await manager.abortRun(runId);
      expect(db.prepare("SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?").get('abort_vid1').cnt).toBe(0);
      expect(db.prepare("SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?").get('abort_vid2').cnt).toBe(1);
    });

    it('signals_done stays 0 when abort deletes signals before in-flight analysis completes', async () => {
      seedTopic(); seedChannel('UC_abort_inflight', 'Abort Inflight Channel');
      vi.mock('./poll', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./poll')>();
        return {
          ...actual,
          pollChannel: vi.fn().mockImplementation(async (database, channelId, options) => {
            if (channelId === 'UC_abort_inflight') {
              const runId = options?.runId ?? 1;
              database.prepare("INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run('inflight_vid1', channelId, 'Inflight Video 1', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);
              database.prepare("INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run('inflight_vid2', channelId, 'Inflight Video 2', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);
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
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (abortSignal?.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
            return { success: true };
          }),
          getLlmConfig: actual.getLlmConfig,
        };
      });

      const { PollRunManager: PRM } = await import('./poll-run-manager');
      const abortManager = new PRM(db);
      const runId = await abortManager.startRun();
      await new Promise((r) => setTimeout(r, 100));
      await abortManager.abortRun(runId);
      await new Promise((r) => setTimeout(r, 3000));

      const progress = db.prepare("SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ? AND channel_id = ?").get(runId, 'UC_abort_inflight') as { signals_found: number; signals_done: number } | undefined;
      expect(progress?.signals_done).toBe(0);
    }, 10000);
  });

  describe('signals_done tracking', () => {
    it('poll_run_progress has signals_done column defaulting to 0', () => {
      const runId = seedRun('running', 3);
      seedProgress(runId, 'UC_test', 'done', 3);
      expect(db.prepare("SELECT signals_done FROM poll_run_progress WHERE poll_run_id = ?").get(runId).signals_done).toBe(0);
    });

    it('signals_done can be incremented independently of status', () => {
      const runId = seedRun('running', 4);
      seedProgress(runId, 'UC_ch1', 'done', 4);
      db.prepare("UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?").run(runId, 'UC_ch1');
      let row = db.prepare("SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?").get(runId) as { signals_found: number; signals_done: number };
      expect(row.signals_found).toBe(4);
      expect(row.signals_done).toBe(1);
      for (let i = 0; i < 3; i++) db.prepare("UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?").run(runId, 'UC_ch1');
      row = db.prepare("SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?").get(runId) as { signals_found: number; signals_done: number };
      expect(row.signals_done).toBe(4);
    });

    it('signals_done is scoped per channel', () => {
      const runId = seedRun('running', 5);
      seedProgress(runId, 'UC_ch1', 'done', 3);
      seedProgress(runId, 'UC_ch2', 'done', 2);
      db.prepare("UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?").run(runId, 'UC_ch1');
      const rows = db.prepare("SELECT channel_id, signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id").all(runId) as Array<{ channel_id: string; signals_found: number; signals_done: number }>;
      expect(rows[0]).toEqual({ channel_id: 'UC_ch1', signals_found: 3, signals_done: 1 });
      expect(rows[1]).toEqual({ channel_id: 'UC_ch2', signals_found: 2, signals_done: 0 });
    });

    it('queryPollRunProgress returns signalsDone in progress rows', () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = seedRun('running', 3);
      seedProgress(runId, 'UC_test', 'done', 3, 2);
      const progress = queryPollRunProgress(db, runId);
      expect(progress[0].signalsDone).toBe(2);
    });

    it('worker increments signals_done for correct channel via signal->channel_id lookup', () => {
      seedTopic();
      seedChannel('UC_ch1', 'Channel 1');
      seedChannel('UC_ch2', 'Channel 2');
      const runResult = db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(Date.now(), 'running', 3);
      const runId = Number(runResult.lastInsertRowid);
      seedProgress(runId, 'UC_ch1', 'done', 2);
      seedProgress(runId, 'UC_ch2', 'done', 1);
      seedSignal('vid_ch1_a', 'UC_ch1', runId);
      seedSignal('vid_ch1_b', 'UC_ch1', runId);
      seedSignal('vid_ch2_a', 'UC_ch2', runId);

      db.prepare("UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = (SELECT channel_id FROM signals WHERE video_id = ?)").run(runId, 'vid_ch1_a');
      let progress = queryPollRunProgress(db, runId);
      expect(progress.find((p) => p.channel_id === 'UC_ch1')!.signalsDone).toBe(1);
      expect(progress.find((p) => p.channel_id === 'UC_ch2')!.signalsDone).toBe(0);

      db.prepare("UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = (SELECT channel_id FROM signals WHERE video_id = ?)").run(runId, 'vid_ch2_a');
      progress = queryPollRunProgress(db, runId);
      expect(progress.find((p) => p.channel_id === 'UC_ch2')!.signalsDone).toBe(1);
    });

    it('RunState steps include signalsDone from progress rows', () => {
      seedTopic(); seedChannel('UC_ch1', 'Channel 1');
      const runResult = db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(Date.now(), 'running', 3);
      const runId = Number(runResult.lastInsertRowid);
      seedProgress(runId, 'UC_ch1', 'done', 3, 1);
      const state = manager.runState(runId);
      expect(state!.steps[0].total).toBe(3);
      expect(state!.steps[0].done).toBe(1);
    });

    it('preRegisterChannelProgress creates rows with signals_done = 0', () => {
      seedTopic(); seedChannel('UC_test', 'Test Channel');
      const runId = seedRun();
      preRegisterChannelProgress(db, runId);
      const row = db.prepare("SELECT channel_id, status, signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?").get(runId) as { channel_id: string; status: string; signals_found: number; signals_done: number };
      expect(row).toEqual({ channel_id: 'UC_test', status: 'fetching', signals_found: 0, signals_done: 0 });
    });

    it('per-channel signals_done is tracked in progress rows', async () => {
      const runId = await manager.startRun();
      await new Promise((r) => setTimeout(r, 300));
      expect(manager.currentProgress()!.progress).toBeDefined();
    });
  });

  describe('stale signal filtering', () => {
    it('does not pick up pending signals from previous aborted runs', () => {
      seedTopic(1, 'mtg'); seedChannel('UC_test', 'Test Channel');
      db.prepare("INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)").run(998, Date.now() - 172800000, 'done-forced', 1);
      seedSignal('old_stale_video', 'UC_test', 998, 'pending');
      const newRunResult = db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)").run(Date.now(), 'running', 30);
      const newRunIdNum = Number(newRunResult.lastInsertRowid);
      seedProgress(newRunIdNum, 'UC_test', 'done', 0);

      const signalsForCurrentRun = db.prepare("SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'").all('UC_test', newRunIdNum) as { video_id: string }[];
      expect(signalsForCurrentRun.length).toBe(0);
      expect(db.prepare("SELECT COUNT(*) as cnt FROM signals WHERE processing_state = 'pending'").get().cnt).toBe(1);
    });

    it('only analyzes signals belonging to the current run', () => {
      seedTopic(1, 'mtg'); seedChannel('UC_test2', 'Test Channel 2');
      db.prepare("INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)").run(997, Date.now() - 86400000, 'done-forced', 2);
      seedSignal('prev_1', 'UC_test2', 997, 'pending');
      seedSignal('prev_2', 'UC_test2', 997, 'pending');
      const currentRunResult = db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)").run(Date.now(), 'running', 30);
      const currentRunId = Number(currentRunResult.lastInsertRowid);
      seedSignal('current_1', 'UC_test2', currentRunId, 'pending');

      const signalsForCurrent = db.prepare("SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'").all('UC_test2', currentRunId) as { video_id: string }[];
      expect(signalsForCurrent.length).toBe(1);
      expect(signalsForCurrent[0].video_id).toBe('current_1');
    });

    it('abort cleanup only deletes pending signals from the aborted run', () => {
      seedTopic(1, 'mtg'); seedChannel('UC_test3', 'Test Channel 3');
      db.prepare("INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)").run(500, Date.now() - 3600000, 'running', 2);
      seedSignal('abort_1', 'UC_test3', 500, 'pending');
      db.prepare("DELETE FROM signals WHERE poll_run_id = ? AND processing_state = 'pending'").run(500);
      expect(db.prepare("SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND processing_state = 'pending'").get(500).cnt).toBe(0);
    });
  });
});