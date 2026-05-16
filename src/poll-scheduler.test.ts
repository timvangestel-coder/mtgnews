import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { enqueuePollRun } from './poll-scheduler';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('poll-scheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('enqueues a PollRun row with running status', () => {
    const runId = enqueuePollRun(db);

    expect(runId).toBeGreaterThan(0);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run).toBeDefined();
    expect(run.status).toBe('running');
    expect(run.triggered_at).toBeTypeOf('number');
    expect(run.completed_at).toBeNull();
    expect(run.new_signal_count).toBe(0);
  });

  it('returns unique ids for consecutive enqueues', () => {
    const id1 = enqueuePollRun(db);
    const id2 = enqueuePollRun(db);

    expect(id1).not.toBe(id2);
  });

  it('stores lookback_days when provided', () => {
    const runId = enqueuePollRun(db, 7);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.lookback_days).toBe(7);
  });

  it('defaults lookback_days to 2 when not provided', () => {
    const runId = enqueuePollRun(db);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.lookback_days).toBe(2);
  });
});
