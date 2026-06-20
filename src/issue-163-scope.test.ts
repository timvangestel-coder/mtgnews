import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../tests/fixtures/test-db';

function seedTopic(db: Database.Database, key: string = 'mtg', id?: number): number {
  if (id) {
    db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(id, key, key.toUpperCase(), key + ' content');
    return id;
  }
  const result = db.prepare("INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)").run(key, key.toUpperCase(), key + ' content');
  return Number(result.lastInsertRowid);
}

function seedChannel(db: Database.Database, channelId: string = 'UC_test', displayName: string = 'Test Channel', topicId?: number): void {
  if (topicId !== undefined) {
    db.prepare("INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)").run(channelId, displayName, Date.now(), topicId);
  } else {
    db.prepare("INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)").run(channelId, displayName, Date.now());
  }
}

function seedSignal(db: Database.Database, videoId: string = 'v1', channelId: string = 'UC_test', title: string = 'Test Video', processingState: string = 'summarized'): void {
  db.prepare(
    "INSERT INTO signals (video_id, channel_id, title, transcription, created_at, processing_state) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(videoId, channelId, title, JSON.stringify({ segments: [] }), Date.now(), processingState);
}

// ─── resolveIndexScope tests (issue #163) ──────────────────────

describe('resolveIndexScope — issue #163 lightweight index data', () => {
  it('returns SignalIndexEntry with videoId, title, summary only', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'My Video Title');
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('A concise summary', 'v1');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { videoId: 'v1' });

    expect(results).toHaveLength(1);
    expect(results[0].videoId).toBe('v1');
    expect(results[0].title).toBe('My Video Title');
    expect(results[0].summary).toBe('A concise summary');
    // Must NOT include compact_text or transcription
    expect((results[0] as any).compactText).toBeUndefined();
    expect((results[0] as any).transcriptionJson).toBeUndefined();
    expect((results[0] as any).signalContext).toBeUndefined();
  });

  it('returns entries for topic-only scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_a', 'Channel A', 1);
    seedSignal(db, 'v1', 'UC_a', 'Video A');
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('Summary A', 'v1');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { topicKey: 'mtg' });

    expect(results).toHaveLength(1);
    expect(results[0].videoId).toBe('v1');
    expect(results[0].title).toBe('Video A');
  });

  it('excludes irrelevant signals by default', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Good Video', 'summarized');
    seedSignal(db, 'v2', 'UC_mtg', 'Irrelevant Video', 'irrelevant');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, {});

    expect(results.length).toBe(1);
    expect(results[0].videoId).toBe('v1');
  });

  it('includes irrelevant signals when includeIrrelevant is true', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Good Video', 'summarized');
    seedSignal(db, 'v2', 'UC_mtg', 'Irrelevant Video', 'irrelevant');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { includeIrrelevant: true });

    expect(results).toHaveLength(2);
  });

  it('defaults summary to empty string when DB has null', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'No Summary Video');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { videoId: 'v1' });

    expect(results[0].summary).toBe('');
  });

  it('throws for non-existent videoId', async () => {
    const db = createTestDb();

    const { resolveIndexScope } = await import('./signal-chat-scope');
    expect(() => resolveIndexScope(db, { videoId: 'nonexistent' })).toThrow();
  });

  it('filters by channelId within topic', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_a', 'A', 1);
    seedChannel(db, 'UC_b', 'B', 1);
    seedSignal(db, 'va', 'UC_a', 'Video A');
    seedSignal(db, 'vb', 'UC_b', 'Video B');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { topicKey: 'mtg', channelId: 'UC_a' });

    expect(results).toHaveLength(1);
    expect(results[0].videoId).toBe('va');
  });

  it('returns entries ordered by published_at DESC', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    // Insert with different published_at to simulate ordering
    const now = Date.now();
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, published_at, created_at, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('v-old', 'UC_mtg', 'Old Video', JSON.stringify({ segments: [] }), new Date(now - 100000).toISOString(), now - 100000, 'summarized');
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, published_at, created_at, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('v-new', 'UC_mtg', 'New Video', JSON.stringify({ segments: [] }), new Date(now).toISOString(), now, 'summarized');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, {});

    expect(results[0].videoId).toBe('v-new');
    expect(results[1].videoId).toBe('v-old');
  });

  it('result shape matches SignalIndexEntry interface exactly', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Test');
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('sum', 'v1');

    const { resolveIndexScope } = await import('./signal-chat-scope');
    const results = resolveIndexScope(db, { videoId: 'v1' });

    // Only three keys: videoId, title, summary
    expect(Object.keys(results[0]).sort()).toEqual(['summary', 'title', 'videoId']);
  });
});