import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { backfillCompactText, BackfillResult } from './backfill-compact-text';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = wal');
  db.exec(`
    CREATE TABLE topics (id INTEGER PRIMARY KEY, key TEXT, filter_text TEXT, summary_prompt TEXT);
    CREATE TABLE channels (channel_id TEXT PRIMARY KEY, display_name TEXT, topic_id INTEGER REFERENCES topics(id));
    CREATE TABLE signals (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(channel_id),
      title TEXT,
      published_at TEXT,
      transcription TEXT,
      summary TEXT,
      overall_sentiment INTEGER,
      sentiment_label TEXT,
      generated_title TEXT,
      compact_text TEXT,
      processing_state TEXT DEFAULT 'new',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);
  return db;
}

describe('backfillCompactText', () => {
  it('returns empty result when no signals have NULL compact_text', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);
    // Signal with compact_text already set
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid1', 'UC_test', '[]', 'already compact');

    const result = await backfillCompactText(db);

    expect(result.total).toBe(0);
    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    db.close();
  });

  it('finds signals with NULL compact_text', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);
    // One signal with compact_text set, one without
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid1', 'UC_test', '[]', 'already compact');
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid2', 'UC_test', '[]', null);

    const result = await backfillCompactText(db);

    expect(result.total).toBe(1);
    db.close();
  });

  it('is idempotent - second run finds zero signals', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid1', 'UC_test', '[]', null);

    // First run finds the signal
    const result1 = await backfillCompactText(db);
    expect(result1.total).toBe(1);

    // Manually set compact_text to simulate successful analysis
    db.prepare("UPDATE signals SET compact_text = ? WHERE video_id = ?").run('backfilled', 'vid1');

    // Second run should find zero (idempotent)
    const result2 = await backfillCompactText(db);
    expect(result2.total).toBe(0);

    db.close();
  });

  it('reports successes when analyzeSignal populates compact_text', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid1', 'UC_test', JSON.stringify([{ time: 0, text: 'hello world' }]), null);

    // Mock analyzeSignal to simulate successful analysis that sets compact_text
    const { analyzeSignal } = await import('./llm');
    vi.spyOn(await import('./llm'), 'analyzeSignal').mockImplementation(async (_db, _videoId, _config, _signal) => {
      // Simulate what a real LLM call does: update compact_text
      _db.prepare("UPDATE signals SET compact_text = ?, summary = ?, overall_sentiment = ?, sentiment_label = ? WHERE video_id = ?")
        .run('hello world', 'summary', 3, 'Neutral', _videoId);
      return { success: true };
    });

    const result = await backfillCompactText(db);

    expect(result.total).toBe(1);
    expect(result.successes).toBe(1);
    expect(result.failures).toBe(0);

    // Verify compact_text was actually written
    const row = db.prepare("SELECT compact_text FROM signals WHERE video_id = ?").get('vid1') as { compact_text: string } | undefined;
    expect(row?.compact_text).toBe('hello world');

    db.close();
  });

  it('reports failures when analyzeSignal fails', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);
    db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
      .run('vid1', 'UC_test', JSON.stringify([{ time: 0, text: 'hello' }]), null);

    vi.spyOn(await import('./llm'), 'analyzeSignal').mockImplementation(async () => ({
      success: false,
      error: 'LLM endpoint unavailable'
    }));

    const result = await backfillCompactText(db);

    expect(result.total).toBe(1);
    expect(result.successes).toBe(0);
    expect(result.failures).toBe(1);

    db.close();
  });

  it('processes multiple signals and reports correct counts', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO topics VALUES (1, 'mtg', 'magic the gathering', NULL)").run();
    db.prepare("INSERT INTO channels VALUES (?, ?, ?)").run('UC_test', 'Test Channel', 1);

    // 3 signals without compact_text
    for (const vid of ['vid1', 'vid2', 'vid3']) {
      db.prepare("INSERT INTO signals (video_id, channel_id, transcription, compact_text) VALUES (?, ?, ?, ?)")
        .run(vid, 'UC_test', JSON.stringify([{ time: 0, text: vid }]), null);
    }

    vi.spyOn(await import('./llm'), 'analyzeSignal').mockImplementation(async (_db, _videoId) => {
      // vid2 fails
      if (_videoId === 'vid2') return { success: false, error: 'timeout' };
      _db.prepare("UPDATE signals SET compact_text = ? WHERE video_id = ?").run(_videoId + '_compact', _videoId);
      return { success: true };
    });

    const result = await backfillCompactText(db);

    expect(result.total).toBe(3);
    expect(result.successes).toBe(2);
    expect(result.failures).toBe(1);

    db.close();
  });
});