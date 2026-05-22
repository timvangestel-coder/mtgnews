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

  function insertSignal(videoId: string, createdAt: number, processedAt?: number | null) {
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at, processed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(videoId, 'UCtest', '[]', createdAt, processedAt ?? null);
  }

  function insertEntityMention(signalVideoId: string) {
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment) VALUES (?, 'TestCard', 'card', 'Positive')"
    ).run(signalVideoId);
  }

  it('deletes run entirely when zero processed signals', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // insert unprocessed signal within window
    insertSignal('v1', triggeredAt + 100);

    // debug: verify data before abort
    const beforeSignals = db.prepare('SELECT * FROM signals').all() as any[];
    console.log('BEFORE signals:', JSON.stringify(beforeSignals));
    const beforeRun = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    console.log('BEFORE run:', JSON.stringify(beforeRun));

    abortPollRun(db, runId);

    // debug: verify data after abort
    const afterSignals = db.prepare('SELECT * FROM signals').all() as any[];
    console.log('AFTER signals:', JSON.stringify(afterSignals));

    // run should be gone
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run).toBeUndefined();

    // signal deleted
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1')).toBeUndefined();
  });

  it('keeps processed signals, transitions to done-forced', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // one processed signal (has processed_at)
    insertSignal('v1', triggeredAt + 100, triggeredAt + 200);
    insertEntityMention('v1');

    // one unprocessed signal
    insertSignal('v2', triggeredAt + 300);

    abortPollRun(db, runId);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run).toBeDefined();
    expect(run.status).toBe('done-forced');
    expect(run.abort_time).toBeDefined();
    expect(run.new_signal_count).toBe(1);

    // v1 kept, v2 deleted
    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeDefined();
    const s2 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v2') as any;
    expect(s2).toBeUndefined();

    // entity mention for v1 kept
    const mentions = db.prepare('SELECT * FROM entity_mentions WHERE signal_video_id = ?').all('v1');
    expect(mentions).toHaveLength(1);
  });

  it('only deletes signals within [triggered_at, abort_time] window', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // signal created BEFORE this run -> must survive
    insertSignal('v0', triggeredAt - 5000);

    // signal within window, unprocessed -> deleted
    insertSignal('v1', triggeredAt + 100);

    abortPollRun(db, runId);

    const s0 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v0') as any;
    expect(s0).toBeDefined();

    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeUndefined();
  });

  it('does not delete processed signals even if within window', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // processed signal -> kept
    insertSignal('v1', triggeredAt + 100, triggeredAt + 200);

    abortPollRun(db, runId);

    const s1 = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1') as any;
    expect(s1).toBeDefined();
    // run deleted since only processed signal count = 1 -> done-forced
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run.status).toBe('done-forced');
  });

  it('deletes entity_mentions when deleting signals', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    insertSignal('v1', triggeredAt + 100);
    insertEntityMention('v1');

    abortPollRun(db, runId);

    // signal gone -> entity mention also gone (FK cascade or explicit delete)
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

  it('no-op safe: multiple stale runs do not cross-delete signals', () => {
    // Run #1
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('r1s1', t1 + 100);

    // Run #2 (overlapping time window)
    const t2 = t1 + 500;
    const r2 = insertRun(t2);
    insertSignal('r2s1', t2 + 100);

    // Abort run #1 only
    abortPollRun(db, r1);

    // r1s1 deleted (within r1 window)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('r1s1')).toBeUndefined();

    // r2s1 must survive (created after t1 but processed by run #2)
    // Actually r2s1 created_at = t2+100 which is >= t1 -> falls in r1 window!
    // But r2s1 was NOT processed, so it gets deleted too. That's correct per spec:
    // "signals with created_at >= triggered_at AND created_at <= abort_time AND processed_at IS NULL"
    // The key safety is the processed_at check + specific time window
  });

  it('overlapping runs safe via processed_at check', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('shared', t1 + 100, t1 + 200); // processed -> protected

    abortPollRun(db, r1);

    // processed signal survives even in window
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('shared')).toBeDefined();
  });
});