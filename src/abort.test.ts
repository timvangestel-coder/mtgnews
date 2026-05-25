import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { abortPollRun } from './abort';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('abort', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UCtest', 'Test Channel');
  });

  afterAll(() => {
    db.close();
  });

  function insertRun(triggeredAt: number, status: string = 'running'): number {
    const result = db.prepare(
      'INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, 2)'
    ).run(triggeredAt, status);
    return Number(result.lastInsertRowid);
  }

  function insertSignal(videoId: string, createdAt: number, processedAt?: number | null, pollRunId?: number | null) {
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at, processed_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(videoId, 'UCtest', '[]', createdAt, processedAt ?? null, pollRunId ?? null);
  }

  function insertEntityMention(signalVideoId: string) {
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment) VALUES (?, 'TestCard', 'card', 'Positive')"
    ).run(signalVideoId);
  }

  it('keeps run as done-forced (zero signals) so UI shows abort status', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // insert unprocessed signal tied to this run
    insertSignal('v1', triggeredAt + 100, null, runId);

    abortPollRun(db, runId);

    // Run row must exist — UI needs it to display "done-forced" status
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run).toBeDefined();
    expect(run.status).toBe('done-forced');
    expect(run.new_signal_count).toBe(0);
    expect(run.abort_time).toBeDefined();

    // signal deleted
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1')).toBeUndefined();
  });

  it('keeps run as done-forced when no signals exist at all', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // No signals inserted — empty poll run aborted immediately
    abortPollRun(db, runId);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run).toBeDefined();
    expect(run.status).toBe('done-forced');
    expect(run.new_signal_count).toBe(0);
  });

  it('keeps processed signals, transitions to done-forced', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // one processed signal tied to this run
    insertSignal('v1', triggeredAt + 100, triggeredAt + 200, runId);
    insertEntityMention('v1');

    // one unprocessed signal tied to this run
    insertSignal('v2', triggeredAt + 300, null, runId);

    abortPollRun(db, runId);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run).toBeDefined();
    expect(run.status).toBe('done-forced');
    expect(run.abort_time).toBeDefined();
    expect(run.new_signal_count).toBe(1);

    // v1 kept (processed), v2 deleted (unprocessed)
    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeDefined();
    const s2 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v2') as any;
    expect(s2).toBeUndefined();

    // entity mention for v1 kept
    const mentions = db.prepare('SELECT * FROM entity_mentions WHERE signal_video_id = ?').all('v1');
    expect(mentions).toHaveLength(1);
  });

  it('only deletes signals belonging to this run (by poll_run_id)', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // signal with no poll_run_id -> must survive (orphan)
    insertSignal('v0', triggeredAt - 5000, null, null);

    // signal tied to this run, unprocessed -> deleted
    insertSignal('v1', triggeredAt + 100, null, runId);

    abortPollRun(db, runId);

    const s0 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v0') as any;
    expect(s0).toBeDefined();

    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeUndefined();
  });

  it('does not delete processed signals even if tied to this run', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // processed signal tied to run -> kept
    insertSignal('v1', triggeredAt + 100, triggeredAt + 200, runId);

    abortPollRun(db, runId);

    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeDefined();
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run.status).toBe('done-forced');
  });

  it('deletes entity_mentions when deleting signals', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    insertSignal('v1', triggeredAt + 100, null, runId);
    insertEntityMention('v1');

    abortPollRun(db, runId);

    // signal gone -> entity mention also gone
    const mentions = db.prepare(
      'SELECT * FROM entity_mentions WHERE signal_video_id = ?'
    ).all('v1') as any[];
    expect(mentions).toHaveLength(0);
  });

  it('throws when run not found', () => {
    expect(() => abortPollRun(db, 999)).toThrow();
  });

  it('throws when run already done-forced', () => {
    const runId = insertRun(Date.now(), 'done-forced');
    expect(() => abortPollRun(db, runId)).toThrow();
  });

  it('no-op safe: multiple runs do not cross-delete signals (FK isolation)', () => {
    // Run #1
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('r1s1', t1 + 100, null, r1);

    // Run #2
    const t2 = t1 + 500;
    const r2 = insertRun(t2);
    insertSignal('r2s1', t2 + 100, null, r2);

    // Abort run #1 only
    abortPollRun(db, r1);

    // r1s1 deleted (poll_run_id = r1)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('r1s1')).toBeUndefined();

    // r2s1 survives (poll_run_id = r2, not r1)
    const r2s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('r2s1') as any;
    expect(r2s1).toBeDefined();
  });

  it('processed signals survive abort via processed_at check', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('shared', t1 + 100, t1 + 200, r1); // processed -> protected

    abortPollRun(db, r1);

    // processed signal survives
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('shared')).toBeDefined();
  });

  // Issue #43: FK-based abort deletion
  it('abort deletes signals by poll_run_id FK (no timestamp window)', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);

    // Signal with poll_run_id = r1 -> deleted
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?)'
    ).run('v1', 'UCtest', '[]', t1 + 100, r1);

    // Signal with poll_run_id = NULL -> survives (not tied to any run)
    insertSignal('v2', t1 + 200);

    abortPollRun(db, r1);

    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1')).toBeUndefined();
    const v2 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v2') as any;
    expect(v2).toBeDefined();
  });

  it('abort cleans entity_mentions by poll_run_id FK', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);

    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?)'
    ).run('v1', 'UCtest', '[]', t1 + 100, r1);
    insertEntityMention('v1');

    abortPollRun(db, r1);

    const mentions = db.prepare(
      'SELECT * FROM entity_mentions WHERE signal_video_id = ?'
    ).all('v1') as any[];
    expect(mentions).toHaveLength(0);
  });

  it('signals without poll_run_id are never deleted by abort', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);

    // Orphaned signal (no poll_run_id) inside time window -> must survive
    insertSignal('orphan', t1 + 50);

    abortPollRun(db, r1);

    const orphan = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('orphan') as any;
    expect(orphan).toBeDefined();
  });
});
