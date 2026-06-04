import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { recoverStaleRuns } from './scheduler';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('recoverStaleRuns', () => {
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

  function insertSignal(videoId: string, createdAt: number, processingState: string = 'pending', pollRunId?: number | null) {
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, transcription, created_at, processing_state, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(videoId, 'UCtest', '[]', createdAt, processingState, pollRunId ?? null);
  }

  function insertEntityMention(signalVideoId: string) {
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment) VALUES (?, 'TestCard', 'card', 'Positive')"
    ).run(signalVideoId);
  }

  it('is a no-op when no stale runs exist', () => {
    const recovered = recoverStaleRuns(db);
    expect(recovered).toBe(0);
  });

  it('deletes run with zero signals', () => {
    const triggeredAt = Date.now();
    insertRun(triggeredAt);

    const recovered = recoverStaleRuns(db);
    expect(recovered).toBe(1);

    // Run should be deleted entirely (no ghost entries)
    const runs = db.prepare("SELECT * FROM poll_runs WHERE status = 'running' AND completed_at IS NULL").all();
    expect(runs).toHaveLength(0);
  });

  it('keeps run as done-forced when summarized signals > 0', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // One summarized signal tied to this run
    insertSignal('v1', triggeredAt + 100, 'summarized', runId);

    const recovered = recoverStaleRuns(db);
    expect(recovered).toBe(1);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run.status).toBe('done-forced');
    expect(run.completed_at).toBeDefined();
    expect(run.new_signal_count).toBe(1);
  });

  it('deletes pending signals and their entity_mentions', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // One summarized signal (kept)
    insertSignal('v1', triggeredAt + 100, 'summarized', runId);
    insertEntityMention('v1');

    // Two pending signals (deleted)
    insertSignal('v2', triggeredAt + 300, 'pending', runId);
    insertEntityMention('v2');
    insertSignal('v3', triggeredAt + 400, 'pending', runId);
    insertEntityMention('v3');

    recoverStaleRuns(db);

    // v1 kept (summarized)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v1')).toBeDefined();
    // v2, v3 deleted (pending)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v2')).toBeUndefined();
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('v3')).toBeUndefined();

    // entity mention for v1 kept
    expect(db.prepare('SELECT * FROM entity_mentions WHERE signal_video_id = ?').all('v1')).toHaveLength(1);
    // entity mentions for v2, v3 deleted
    expect(db.prepare('SELECT * FROM entity_mentions WHERE signal_video_id = ?').all('v2')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM entity_mentions WHERE signal_video_id = ?').all('v3')).toHaveLength(0);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run.status).toBe('done-forced');
    expect(run.new_signal_count).toBe(1);
  });

  it('handles multiple stale runs in a single startup', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('r1s1', t1 + 100, 'pending', r1); // pending -> deleted

    const t2 = t1 + 500;
    const r2 = insertRun(t2);
    insertSignal('r2s1', t2 + 100, 'summarized', r2); // summarized -> kept

    const t3 = t2 + 500;
    const r3 = insertRun(t3);
    // no signals -> deleted entirely

    const recovered = recoverStaleRuns(db);
    expect(recovered).toBe(3);

    // Run #1: all signals deleted, run deleted (zero non-pending)
    expect(db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(r1)).toBeUndefined();

    // Run #2: summarized signal kept, run is done-forced
    const run2 = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(r2) as any;
    expect(run2.status).toBe('done-forced');
    expect(run2.new_signal_count).toBe(1);

    // Run #3: no signals, deleted entirely
    expect(db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(r3)).toBeUndefined();
  });

  it('does not affect normal completed runs', () => {
    const triggeredAt = Date.now();
    const runId = insertRun(triggeredAt);

    // Mark as done (normal completion)
    db.prepare(
      "UPDATE poll_runs SET status = 'done', completed_at = ?, new_signal_count = 2 WHERE id = ?"
    ).run(Date.now(), runId);

    insertSignal('v1', triggeredAt + 100, 'summarized', runId);

    recoverStaleRuns(db);

    // Run untouched
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId) as any;
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2);
  });

  it('does not delete signals from other runs', () => {
    const t1 = Date.now();
    const r1 = insertRun(t1);
    insertSignal('r1s1', t1 + 100, 'pending', r1); // pending in run #1

    const t2 = t1 + 500;
    const r2 = insertRun(t2);
    insertSignal('r2s1', t2 + 100, 'pending', r2); // pending in run #2

    recoverStaleRuns(db);

    // Both runs are stale -> both recovered
    // r1s1 deleted (run #1 had zero non-pending)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('r1s1')).toBeUndefined();
    // r2s1 deleted (run #2 had zero non-pending)
    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('r2s1')).toBeUndefined();
  });

  it('preserves signals with no poll_run_id', () => {
    const triggeredAt = Date.now();
    insertRun(triggeredAt);

    // Orphan signal (no poll_run_id) -> must survive
    insertSignal('orphan', triggeredAt + 50, 'pending', null);

    recoverStaleRuns(db);

    expect(db.prepare('SELECT * FROM signals WHERE video_id = ?').get('orphan')).toBeDefined();
  });
});