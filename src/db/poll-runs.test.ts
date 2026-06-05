import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addChannel, createTopic } from './watchlist';
import { preRegisterChannelProgress } from './poll-runs';
import { createTestDb } from '../../tests/fixtures/test-db';

describe('preRegisterChannelProgress', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('inserts pending rows for all active channels with topic_id', () => {
    // Create a topic and two active channels
    createTopic(db, 'mtg', 'MTG', 'magic the gathering');
    addChannel(db, 'UC1', 'Channel One', null, 1);
    addChannel(db, 'UC2', 'Channel Two', null, 1);

    // Create a poll run
    const runId = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
    ).run(Date.now());
    const rid = Number(runId.lastInsertRowid);

    preRegisterChannelProgress(db, rid);

    const rows = db.prepare(
      "SELECT channel_id, status FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id"
    ).all(rid) as Array<{ channel_id: string; status: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].channel_id).toBe('UC1');
    expect(rows[0].status).toBe('fetching');
    expect(rows[1].channel_id).toBe('UC2');
    expect(rows[1].status).toBe('fetching');
  });

  it('skips inactive channels', () => {
    createTopic(db, 'mtg', 'MTG', 'magic the gathering');
    addChannel(db, 'UC1', 'Active Channel', null, 1);
    addChannel(db, 'UC2', 'Inactive Channel', null, 1);

    // Deactivate UC2
    db.prepare('UPDATE channels SET active = 0 WHERE channel_id = ?').run('UC2');

    const runId = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
    ).run(Date.now());
    const rid = Number(runId.lastInsertRowid);

    preRegisterChannelProgress(db, rid);

    const rows = db.prepare(
      "SELECT channel_id FROM poll_run_progress WHERE poll_run_id = ?"
    ).all(rid) as Array<{ channel_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe('UC1');
  });

  it('skips channels with NULL topic_id', () => {
    // Active channel with no topic
    addChannel(db, 'UC1', 'No Topic Channel', null, null);
    createTopic(db, 'mtg', 'MTG', 'magic the gathering');
    addChannel(db, 'UC2', 'With Topic Channel', null, 1);

    const runId = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
    ).run(Date.now());
    const rid = Number(runId.lastInsertRowid);

    preRegisterChannelProgress(db, rid);

    const rows = db.prepare(
      "SELECT channel_id FROM poll_run_progress WHERE poll_run_id = ?"
    ).all(rid) as Array<{ channel_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe('UC2');
  });

  it('does nothing when no active channels exist', () => {
    const runId = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
    ).run(Date.now());
    const rid = Number(runId.lastInsertRowid);

    preRegisterChannelProgress(db, rid);

    const count = db.prepare(
      "SELECT COUNT(*) as c FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(rid) as { c: number };

    expect(count.c).toBe(0);
  });

  it('sets signals_found to 0 for pending rows', () => {
    createTopic(db, 'mtg', 'MTG', 'magic the gathering');
    addChannel(db, 'UC1', 'Channel One', null, 1);

    const runId = db.prepare(
      "INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, 'running', 0, 2)"
    ).run(Date.now());
    const rid = Number(runId.lastInsertRowid);

    preRegisterChannelProgress(db, rid);

    const row = db.prepare(
      "SELECT signals_found, updated_at FROM poll_run_progress WHERE poll_run_id = ?"
    ).get(rid) as { signals_found: number; updated_at: number };

    expect(row.signals_found).toBe(0);
    expect(row.updated_at).toBeTypeOf('number');
  });
});