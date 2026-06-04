import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { getPollRunById, queryPollRunProgress, preRegisterChannelProgress } from './db/poll-runs';
import { PollRunManager } from './poll-run-manager';

/**
 * Tests for signals_done tracking in poll_run_progress.
 *
 * Problem: Channel progress shows "done (4)" as soon as Phase 1 (RSS polling) finishes,
 * even though Phase 2 (LLM summarization) hasn't started yet. The UI can't distinguish
 * between "channel polled, found 4 signals" and "all 4 signals summarized."
 *
 * Fix: Add `signals_done` column to poll_run_progress. Worker increments it after each
 * successful analyzeSignal(). UI shows "summarizing (X/Y)" during Phase 2.
 */
describe('signals_done tracking', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDb(db);
  });

  afterAll(() => {
    db.close();
  });

  it('poll_run_progress has signals_done column defaulting to 0', () => {
    // Setup: create a run and progress row
    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
    ).run(Date.now(), 'running', 3);
    const runId = Number(runResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_test', 'done', 3, Date.now());

    // Read the row back — signals_done should exist and default to 0
    const row = db.prepare(
      "SELECT signals_done FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(runId) as { signals_done: number } | undefined;

    expect(row).toBeDefined();
    expect(row.signals_done).toBe(0);
  });

  it('signals_done can be incremented independently of status', () => {
    // Setup
    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
    ).run(Date.now(), 'running', 4);
    const runId = Number(runResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch1', 'done', 4, Date.now());

    // Simulate: 1 signal summarized
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?"
    ).run(runId, 'UC_ch1');

    const row = db.prepare(
      "SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(runId) as { signals_found: number; signals_done: number };

    expect(row.signals_found).toBe(4);
    expect(row.signals_done).toBe(1);

    // Simulate: 3 more signals summarized (out-of-order completion)
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?"
    ).run(runId, 'UC_ch1');
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?"
    ).run(runId, 'UC_ch1');
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?"
    ).run(runId, 'UC_ch1');

    const finalRow = db.prepare(
      "SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(runId) as { signals_found: number; signals_done: number };

    expect(finalRow.signals_found).toBe(4);
    expect(finalRow.signals_done).toBe(4);
  });

  it('signals_done is scoped per channel (incrementing one does not affect others)', () => {
    // Setup: two channels in same run
    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
    ).run(Date.now(), 'running', 5);
    const runId = Number(runResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch1', 'done', 3, Date.now());
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch2', 'done', 2, Date.now());

    // Summarize 1 signal for ch1 only
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = signals_done + 1 WHERE poll_run_id = ? AND channel_id = ?"
    ).run(runId, 'UC_ch1');

    const rows = db.prepare(
      "SELECT channel_id, signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id"
    ).all(runId) as Array<{ channel_id: string; signals_found: number; signals_done: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ channel_id: 'UC_ch1', signals_found: 3, signals_done: 1 });
    expect(rows[1]).toEqual({ channel_id: 'UC_ch2', signals_found: 2, signals_done: 0 });
  });

  it('queryPollRunProgress returns signalsDone in progress rows', () => {
    // Setup
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
    ).run(Date.now(), 'running', 3);
    const runId = Number(runResult.lastInsertRowid);

    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_test', 'done', 3, Date.now());
    // Simulate 2 of 3 summarized
    db.prepare(
      "UPDATE poll_run_progress SET signals_done = 2 WHERE poll_run_id = ?"
    ).run(runId);

    const progress = queryPollRunProgress(db, runId);

    expect(progress).toHaveLength(1);
    expect(progress[0].signalsDone).toBe(2);
    expect(progress[0].signals_found).toBe(3);
  });

  it('worker increments signals_done for the correct channel after analyzeSignal', () => {
    // Setup: two channels, each with signals in the same run
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_ch1', 'Channel 1', Date.now(), 1);
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_ch2', 'Channel 2', Date.now(), 1);

    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, phase, signals_analyzed, signals_to_analyze) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(Date.now(), 'running', 3, 'analyzing', 0, 3);
    const runId = Number(runResult.lastInsertRowid);

    // Phase 1 complete: ch1 has 2 signals, ch2 has 1 signal
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch1', 'done', 2, Date.now());
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch2', 'done', 1, Date.now());

    // Insert signals with their channel_id and poll_run_id
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('vid_ch1_a', 'UC_ch1', 'Ch1 Video A', new Date().toISOString(), '[]', Date.now(), runId);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('vid_ch1_b', 'UC_ch1', 'Ch1 Video B', new Date().toISOString(), '[]', Date.now(), runId);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('vid_ch2_a', 'UC_ch2', 'Ch2 Video A', new Date().toISOString(), '[]', Date.now(), runId);

    // Simulate: worker increments signals_done for UC_ch1 after analyzing vid_ch1_a
    // This is the SQL the worker will execute (via signal -> channel_id lookup)
    db.prepare(`
      UPDATE poll_run_progress SET signals_done = signals_done + 1
      WHERE poll_run_id = ?
        AND channel_id = (SELECT channel_id FROM signals WHERE video_id = ?)
    `).run(runId, 'vid_ch1_a');

    const progress = queryPollRunProgress(db, runId);
    expect(progress).toHaveLength(2);

    const ch1 = progress.find((p) => p.channel_id === 'UC_ch1')!;
    const ch2 = progress.find((p) => p.channel_id === 'UC_ch2')!;

    // ch1 should have 1/2 summarized, ch2 still 0/1
    expect(ch1.signalsDone).toBe(1);
    expect(ch1.signals_found).toBe(2);
    expect(ch2.signalsDone).toBe(0);
    expect(ch2.signals_found).toBe(1);

    // Simulate: worker increments for UC_ch2 after analyzing vid_ch2_a
    db.prepare(`
      UPDATE poll_run_progress SET signals_done = signals_done + 1
      WHERE poll_run_id = ?
        AND channel_id = (SELECT channel_id FROM signals WHERE video_id = ?)
    `).run(runId, 'vid_ch2_a');

    const progress2 = queryPollRunProgress(db, runId);
    const ch2After = progress2.find((p) => p.channel_id === 'UC_ch2')!;
    expect(ch2After.signalsDone).toBe(1);
    expect(ch2After.signals_found).toBe(1);
  });

  it('RunState steps include signalsDone from progress rows', () => {
    // This test verifies the PollRunStep interface and runState() mapping
    // carry signalsDone through to the view model
    const manager = new PollRunManager(db);

    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_ch1', 'Channel 1', Date.now(), 1);

    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, phase, signals_analyzed, signals_to_analyze) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(Date.now(), 'running', 3, 'analyzing', 1, 3);
    const runId = Number(runResult.lastInsertRowid);

    // Simulate: Phase 1 done (3 signals found), Phase 2 in progress (1 summarized)
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, signals_done, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(runId, 'UC_ch1', 'done', 3, 1, Date.now());

    const state = manager.runState(runId);
    expect(state).not.toBeNull();
    expect(state!.steps).toHaveLength(1);
    // Renamed in issue #79: signalsFound → total, signalsDone → done
    expect(state!.steps[0].total).toBe(3);
    expect(state!.steps[0].done).toBe(1);
  });

  it('preRegisterChannelProgress creates rows with signals_done = 0', () => {
    db.prepare(
      "INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
    ).run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_test', 'Test Channel', Date.now(), 1);

    const runResult = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)"
    ).run(Date.now(), 'running', 0);
    const runId = Number(runResult.lastInsertRowid);

    preRegisterChannelProgress(db, runId);

    // Verify the pre-registered row has signals_done = 0
    const row = db.prepare(
      "SELECT channel_id, status, signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(runId) as { channel_id: string; status: string; signals_found: number; signals_done: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.channel_id).toBe('UC_test');
    expect(row!.status).toBe('fetching');
    expect(row!.signals_found).toBe(0);
    expect(row!.signals_done).toBe(0);
  });
});
