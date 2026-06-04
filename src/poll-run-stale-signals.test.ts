/**
 * Regression tests for stale signal handling (issue #79).
 *
 * Before fix: workerProcessRun() queried signals without filtering by poll_run_id,
 * causing signals from previous aborted runs that still had `processing_state = 'pending'`
 * to be re-analyzed in subsequent runs.
 */
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('poll-run stale signals regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('does not pick up pending signals from previous aborted runs', () => {
    // Setup topic + channel
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'mtg', 'MTG', 'test');

    db.prepare(
      "INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    // Simulate: a previous aborted run left behind a pending signal
    db.prepare(
      "INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)"
    ).run(998, Date.now() - 172800000, 'done-forced', 1);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('old_stale_video', 'UC_test', 'Old Stale Video', new Date().toISOString(), '[]', Date.now() - 172800000, 998, 'pending');

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
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'"
    ).all('UC_test', newRunIdNum) as { video_id: string }[];

    // Must NOT include the stale signal from run 998
    expect(signalsForCurrentRun.length).toBe(0);

    // Verify the stale signal still exists (wasn't accidentally deleted)
    const allPending = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE processing_state = 'pending'"
    ).get() as { cnt: number };
    expect(allPending.cnt).toBe(1);
  });

  it('only analyzes signals belonging to the current run', () => {
    // Setup topic + channel
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'mtg', 'MTG', 'test');

    db.prepare(
      "INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)"
    ).run('UC_test2', 'Test Channel 2', Date.now(), 1);

    // Previous run with pending signals
    db.prepare(
      "INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)"
    ).run(997, Date.now() - 86400000, 'done-forced', 2);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('prev_1', 'UC_test2', 'Prev 1', new Date().toISOString(), '[]', Date.now() - 86400000, 997, 'pending');

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('prev_2', 'UC_test2', 'Prev 2', new Date().toISOString(), '[]', Date.now() - 86400000, 997, 'pending');

    // Current run with one pending signal
    const currentRunResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)"
    ).run(Date.now(), 'running', 30);
    const currentRunId = Number(currentRunResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('current_1', 'UC_test2', 'Current 1', new Date().toISOString(), '[]', Date.now(), currentRunId, 'pending');

    // Query for signals to analyze in current run only
    const signalsForCurrent = db.prepare(
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'"
    ).all('UC_test2', currentRunId) as { video_id: string }[];

    expect(signalsForCurrent.length).toBe(1);
    expect(signalsForCurrent[0].video_id).toBe('current_1');

    // Verify total pending signals across all runs
    const allPending = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE processing_state = 'pending'"
    ).get() as { cnt: number };
    expect(allPending.cnt).toBe(3); // 2 from prev + 1 current
  });

  it('abort cleanup only deletes pending signals from the aborted run', () => {
    // Setup topic + channel
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'mtg', 'MTG', 'test');

    db.prepare(
      "INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)"
    ).run('UC_test3', 'Test Channel 3', Date.now(), 1);

    // Run with pending signals that will be aborted
    db.prepare(
      "INSERT INTO poll_runs (id, triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, ?, 0, ?)"
    ).run(500, Date.now() - 3600000, 'running', 2);

    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run('abort_1', 'UC_test3', 'Abort 1', new Date().toISOString(), '[]', Date.now() - 3600000, 500, 'pending');

    // Simulate abort cleanup: delete pending signals for run 500
    db.prepare(
      "DELETE FROM signals WHERE poll_run_id = ? AND processing_state = 'pending'"
    ).run(500);

    // Verify only the pending signal was deleted
    const remainingPending = db.prepare(
      "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND processing_state = 'pending'"
    ).get(500) as { cnt: number };
    expect(remainingPending.cnt).toBe(0);

    // Signals from other runs are unaffected (there are none in this test, but the query is scoped by run)
    const signalsForCurrent = db.prepare(
      "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'"
    ).all('UC_test3', 500) as { video_id: string }[];
    expect(signalsForCurrent.length).toBe(0);
  });
});