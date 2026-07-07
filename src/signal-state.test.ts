import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { markSummarized, markIrrelevant, markRelevant, isPending, isIrrelevant, isSummarized, deletePendingForRun, countProcessedForRun, pendingSignalsForChannel } from './signal-state';
import { createTestDb, seedChannel, seedSignal } from '../tests/fixtures/test-db';

describe('signal-state predicates', () => {
  it('isPending returns true for pending state', () => {
    expect(isPending('pending')).toBe(true);
  });

  it('isPending returns false for non-pending states', () => {
    expect(isPending('summarized')).toBe(false);
    expect(isPending('irrelevant')).toBe(false);
  });

  it('isIrrelevant returns true for irrelevant state', () => {
    expect(isIrrelevant('irrelevant')).toBe(true);
  });

  it('isIrrelevant returns false for non-irrelevant states', () => {
    expect(isIrrelevant('pending')).toBe(false);
    expect(isIrrelevant('summarized')).toBe(false);
  });

  it('isSummarized returns true for summarized state', () => {
    expect(isSummarized('summarized')).toBe(true);
  });

  it('isSummarized returns false for non-summarized states', () => {
    expect(isSummarized('pending')).toBe(false);
    expect(isSummarized('irrelevant')).toBe(false);
  });
});

describe('markIrrelevant', () => {
  it('sets processing_state to irrelevant for the given video_id', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');

    markIrrelevant(db, 'v1');

    const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v1') as { processing_state: string };
    expect(sig.processing_state).toBe('irrelevant');
  });

  it('does not affect other signals', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');
    seedSignal(db, 'v2', 'transcription text');

    markIrrelevant(db, 'v1');

    const sig2 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v2') as { processing_state: string };
    expect(sig2.processing_state).toBe('pending');
  });
});

describe('markSummarized', () => {
  it('sets processing_state to summarized for the given video_id', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');

    markSummarized(db, 'v1');

    const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v1') as { processing_state: string };
    expect(sig.processing_state).toBe('summarized');
  });

  it('does not affect other signals', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');
    seedSignal(db, 'v2', 'transcription text');

    markSummarized(db, 'v1');

    const sig2 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v2') as { processing_state: string };
    expect(sig2.processing_state).toBe('pending');
  });
});

function insertPollRun(db: Database.Database): number {
  db.prepare('INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)').run(Date.now(), 'running', 0);
  const row = db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number };
  return row.max_id;
}

describe('deletePendingForRun', () => {
  it('deletes pending signals and their entity_mentions for a given runId', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runId = insertPollRun(db);
    // Insert a pending signal with an entity_mention
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCtest', 'Pending Video', 'transcription', Date.now(), runId);
    db.prepare('INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment) VALUES (?, ?, ?, ?)')
      .run('v1', 'TestEntity', 'PERSON', 'positive');
    // Insert a summarized signal in same run (should NOT be deleted)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v2', 'UCtest', 'Summarized Video', 'transcription', Date.now(), runId, 'summarized');
    // Insert an irrelevant signal in same run (should NOT be deleted)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v3', 'UCtest', 'Irrelevant Video', 'transcription', Date.now(), runId, 'irrelevant');

    deletePendingForRun(db, runId);

    // Pending signal and its entity_mention are gone
    expect(db.prepare('SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?').get('v1') as { cnt: number }).toHaveProperty('cnt', 0);
    expect(db.prepare('SELECT COUNT(*) as cnt FROM entity_mentions WHERE signal_video_id = ?').get('v1') as { cnt: number }).toHaveProperty('cnt', 0);
    // Summarized and irrelevant signals survive
    expect(db.prepare('SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?').get('v2') as { cnt: number }).toHaveProperty('cnt', 1);
    expect(db.prepare('SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?').get('v3') as { cnt: number }).toHaveProperty('cnt', 1);
  });

  it('does not affect signals from other runs', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runIdA = insertPollRun(db);
    const runIdB = insertPollRun(db);
    // Pending signal in run A (different run)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v10', 'UCtest', 'Other Run Video', 'transcription', Date.now(), runIdA);

    deletePendingForRun(db, runIdB);

    expect(db.prepare('SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?').get('v10') as { cnt: number }).toHaveProperty('cnt', 1);
  });

  it('handles runId with no pending signals gracefully', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runId = insertPollRun(db);
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v20', 'UCtest', 'Summarized Only', 'transcription', Date.now(), runId, 'summarized');

    // Should not throw
    deletePendingForRun(db, runId);

    expect(db.prepare('SELECT COUNT(*) as cnt FROM signals WHERE video_id = ?').get('v20') as { cnt: number }).toHaveProperty('cnt', 1);
  });
});

describe('countProcessedForRun', () => {
  it('counts non-pending signals for a given runId', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runId = insertPollRun(db);
    // Pending signal (should NOT be counted)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCtest', 'Pending', 'transcription', Date.now(), runId);
    // Summarized signal (should be counted)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v2', 'UCtest', 'Summarized', 'transcription', Date.now(), runId, 'summarized');
    // Irrelevant signal (should be counted)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v3', 'UCtest', 'Irrelevant', 'transcription', Date.now(), runId, 'irrelevant');

    const count = countProcessedForRun(db, runId);

    expect(count).toBe(2);
  });

  it('returns 0 when no signals exist for the run', () => {
    const db = createTestDb();
    insertPollRun(db);

    const count = countProcessedForRun(db, 1);

    expect(count).toBe(0);
  });

  it('does not count signals from other runs', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runIdA = insertPollRun(db);
    // Signal in run A only
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCtest', 'Other Run', 'transcription', Date.now(), runIdA, 'summarized');

    const count = countProcessedForRun(db, 999);

    expect(count).toBe(0);
  });
});

describe('markRelevant', () => {
  it('sets processing_state to summarized when summary exists', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');
    // Mark as irrelevant first, then add a summary
    markIrrelevant(db, 'v1');
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('Some summary', 'v1');

    markRelevant(db, 'v1');

    const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v1') as { processing_state: string };
    expect(sig.processing_state).toBe('summarized');
  });

  it('sets processing_state to pending when no summary exists', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');
    // Mark as irrelevant, no summary
    markIrrelevant(db, 'v1');

    markRelevant(db, 'v1');

    const sig = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v1') as { processing_state: string };
    expect(sig.processing_state).toBe('pending');
  });

  it('does not affect other signals', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedSignal(db, 'v1', 'transcription text');
    seedSignal(db, 'v2', 'transcription text');
    markIrrelevant(db, 'v1');
    markIrrelevant(db, 'v2');

    markRelevant(db, 'v1');

    const sig2 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v2') as { processing_state: string };
    expect(sig2.processing_state).toBe('irrelevant');
  });
});

describe('pendingSignalsForChannel', () => {
  it('returns pending signals for a given channel and runId', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runId = insertPollRun(db);
    // Pending signal (should be returned)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCtest', 'Pending 1', 'transcription', Date.now(), runId);
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v2', 'UCtest', 'Pending 2', 'transcription', Date.now(), runId);
    // Summarized signal in same channel+run (should NOT be returned)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v3', 'UCtest', 'Summarized', 'transcription', Date.now(), runId, 'summarized');

    const signals = pendingSignalsForChannel(db, 'UCtest', runId);

    expect(signals).toHaveLength(2);
    const videoIds = signals.map((s: any) => s.video_id).sort();
    expect(videoIds).toEqual(['v1', 'v2']);
  });

  it('returns empty array when no pending signals for the channel', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    const runId = insertPollRun(db);
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCtest', 'Summarized Only', 'transcription', Date.now(), runId, 'summarized');

    const signals = pendingSignalsForChannel(db, 'UCtest', runId);

    expect(signals).toHaveLength(0);
  });

  it('does not return signals from other channels or runs', () => {
    const db = createTestDb();
    seedChannel(db, 'UCtest');
    seedChannel(db, 'UCother');
    const runIdA = insertPollRun(db);
    const runIdB = insertPollRun(db);
    // Pending in different channel (should NOT be returned)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v1', 'UCother', 'Other Channel', 'transcription', Date.now(), runIdA);
    // Pending in different run (should NOT be returned)
    db.prepare('INSERT INTO signals (video_id, channel_id, title, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v2', 'UCtest', 'Other Run', 'transcription', Date.now(), runIdB);

    const signals = pendingSignalsForChannel(db, 'UCtest', runIdA);

    expect(signals).toHaveLength(0);
  });
});
