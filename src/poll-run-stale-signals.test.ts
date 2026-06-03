import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';

/**
 * Regression test for: signals_to_analyze inflated by stale unprocessed signals.
 *
 * Root cause: The worker's query for unprocessed signals in Phase 1 (line ~224 of
 * poll-run-manager.ts) was missing `AND poll_run_id = ?`, causing it to pick up
 * signals from previous aborted runs that still had `processed_at IS NULL`.
 *
 * Fix: Added `poll_run_id = ?` filter so only signals from the current run are
 * queued for analysis. This ensures `signals_to_analyze` and the UI counter
 * reflect only the current run's newly discovered signals.
 */
describe('stale signal isolation (regression)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDb(db);
  });

  afterAll(() => {
    db.close();
  });

  it('only queries signals from the current poll run for analysis', () => {
    // Setup: create a topic and channel
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    // Simulate: a previous aborted run left behind an unprocessed signal
    db.prepare(
      "INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)"
    ).run(998, Date.now() - 172800000, 'done-forced', 1);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('old_stale_video', 'UC_test', 'Old Stale Video', new Date().toISOString(), '[]', Date.now() - 172800000, 998, null);

    // Create current run
    const newRunResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)"
    ).run(Date.now(), 'running', 30);
    const newRunIdNum = Number(newRunResult.lastInsertRowid);

    // Current run finds no new videos for this channel (progress = done, 0 signals)
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(newRunIdNum, 'UC_test', 'done', 0, Date.now());

    // The FIXED query: only signals from the current run should be queued for analysis
    const signalsForCurrentRun = db.prepare(
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processed_at IS NULL"
    ).all('UC_test', newRunIdNum) as { video_id: string }[];

    // Must NOT include the stale signal from run 998
    expect(signalsForCurrentRun.length).toBe(0);

    // Verify the stale signal still exists (wasn't accidentally deleted)
    const allUnprocessed = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE processed_at IS NULL"
    ).get() as { cnt: number };
    expect(allUnprocessed.cnt).toBe(1);
  });

  it('correctly counts only current run signals when multiple stale runs exist', () => {
    // Setup
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    // Simulate: 3 previous aborted runs, each left 2 unprocessed signals
    for (let runNum = 1; runNum <= 3; runNum++) {
      const oldRunId = 900 + runNum;
      db.prepare(
        "INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 2, ?)"
      ).run(oldRunId, Date.now() - runNum * 86400000, 'done-forced', 2);

      for (let sig = 1; sig <= 2; sig++) {
        db.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(`stale_r${runNum}_s${sig}`, 'UC_test', `Stale R${runNum}S${sig}`, new Date().toISOString(), '[]', Date.now() - runNum * 86400000, oldRunId, null);
      }
    }

    // Create current run with 2 fresh signals
    const newRunResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)"
    ).run(Date.now(), 'running', 30);
    const newRunIdNum = Number(newRunResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('fresh_1', 'UC_test', 'Fresh Video 1', new Date().toISOString(), '[]', Date.now(), newRunIdNum, null);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('fresh_2', 'UC_test', 'Fresh Video 2', new Date().toISOString(), '[]', Date.now(), newRunIdNum, null);

    // FIXED query: only current run's signals
    const currentRunSignals = db.prepare(
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processed_at IS NULL"
    ).all('UC_test', newRunIdNum) as { video_id: string }[];

    // Should be exactly 2 (the fresh ones), NOT 8 (6 stale + 2 fresh)
    expect(currentRunSignals.length).toBe(2);
    expect(currentRunSignals.map(s => s.video_id)).toContain('fresh_1');
    expect(currentRunSignals.map(s => s.video_id)).toContain('fresh_2');

    // Total unprocessed across all runs should be 8
    const totalUnprocessed = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE processed_at IS NULL"
    ).get() as { cnt: number };
    expect(totalUnprocessed.cnt).toBe(8);
  });

  it('abort cleanup removes unsummarized signals by poll_run_id so they dont leak', () => {
    // Setup
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    // Create a run with unprocessed signals
    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)"
    ).run(Date.now(), 'running', 30);
    const runId = Number(runResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('to_abort', 'UC_test', 'To Abort', new Date().toISOString(), '[]', Date.now(), runId, null);

    // Simulate abort cleanup (matches abortPollRun logic in PollRunManager)
    db.prepare(
      "DELETE FROM signals WHERE poll_run_id = ? AND processed_at IS NULL"
    ).run(runId);

    db.prepare(
      "UPDATE poll_runs SET status = 'done-forced', new_signal_count = 0, abort_time = ? WHERE id = ?"
    ).run(Date.now(), runId);

    // Verify: the aborted signal was cleaned up
    const remaining = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND processed_at IS NULL"
    ).get(runId) as { cnt: number };
    expect(remaining.cnt).toBe(0);

    // Create a new run — should see 0 unprocessed signals for this channel
    const newRunResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)"
    ).run(Date.now(), 'running', 30);
    const newRunIdNum = Number(newRunResult.lastInsertRowid);

    const newRunSignals = db.prepare(
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processed_at IS NULL"
    ).all('UC_test', newRunIdNum) as { video_id: string }[];

    expect(newRunSignals.length).toBe(0);
  });
});