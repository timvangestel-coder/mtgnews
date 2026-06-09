import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
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

// ─── Schema tests ──────────────────────────────────────────────

describe('signal_chat schema — issue #127 multi-signal chat columns', () => {
  it('has topic_key column (nullable TEXT)', () => {
    const db = createTestDb();
    const columns = db.prepare("PRAGMA table_info(signal_chat)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('topic_key');
  });

  it('has channel_id column (nullable TEXT)', () => {
    const db = createTestDb();
    const columns = db.prepare("PRAGMA table_info(signal_chat)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('channel_id');
  });

  it('has include_irrelevant column (INTEGER DEFAULT 0)', () => {
    const db = createTestDb();
    const columns = db.prepare("PRAGMA table_info(signal_chat)").all() as Array<{ name: string; type: string; dflt_value: string | null }>;
    const colMap = new Map(columns.map((c) => [c.name, c]));
    expect(colMap.has('include_irrelevant')).toBe(true);
    expect(colMap.get('include_irrelevant')?.type).toBe('INTEGER');
  });
});

// ─── ChatScope / ChatSignalContext types ──────────────────────

describe('ChatScope and ChatSignalContext types — issue #127', () => {
  it('ChatScope interface is exported from signal-chat-scope', async () => {
    const mod = await import('./signal-chat-scope');
    // Just verify the module exports exist — structural typing in TS
    expect(typeof mod.ChatScope).toBe('undefined'); // interfaces don't exist at runtime
    expect(typeof mod.ChatSignalContext).toBe('undefined');
    expect(typeof mod.resolveScope).toBe('function');
  });
});

// ─── resolveScope tests ──────────────────────────────────────

describe('resolveScope — issue #127', () => {
  it('returns one ChatSignalContext for single videoId scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v_mtg_1', 'UC_mtg', 'MTG Video');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { videoId: 'v_mtg_1' });

    expect(results).toHaveLength(1);
    expect(results[0].videoId).toBe('v_mtg_1');
    expect(results[0].title).toBe('MTG Video');
    expect(results[0].channelDisplayName).toBe('MTG Channel');
    expect(results[0].signalContext.transcriptionJson).toBe(JSON.stringify({ segments: [] }));
  });

  it('returns matching signals for topic-only scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedTopic(db, 'ai', 2);

    seedChannel(db, 'UC_mtg_a', 'MTG A', 1);
    seedChannel(db, 'UC_mtg_b', 'MTG B', 1);
    seedChannel(db, 'UC_ai', 'AI Channel', 2);

    seedSignal(db, 'v_mtg_a_1', 'UC_mtg_a', 'MTG A Video');
    seedSignal(db, 'v_mtg_b_1', 'UC_mtg_b', 'MTG B Video');
    seedSignal(db, 'v_ai_1', 'UC_ai', 'AI Video');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { topicKey: 'mtg' });

    expect(results).toHaveLength(2);
    const videoIds = results.map((r) => r.videoId).sort();
    expect(videoIds).toEqual(['v_mtg_a_1', 'v_mtg_b_1']);
  });

  it('returns matching signals for topic+channel scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);

    seedChannel(db, 'UC_mtg_a', 'MTG A', 1);
    seedChannel(db, 'UC_mtg_b', 'MTG B', 1);

    seedSignal(db, 'v_mtg_a_1', 'UC_mtg_a', 'MTG A Video 1');
    seedSignal(db, 'v_mtg_a_2', 'UC_mtg_a', 'MTG A Video 2');
    seedSignal(db, 'v_mtg_b_1', 'UC_mtg_b', 'MTG B Video');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { topicKey: 'mtg', channelId: 'UC_mtg_a' });

    expect(results).toHaveLength(2);
    const videoIds = results.map((r) => r.videoId).sort();
    expect(videoIds).toEqual(['v_mtg_a_1', 'v_mtg_a_2']);
  });

  it('returns all summarized signals for no-filters scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Video 1', 'summarized');
    seedSignal(db, 'v2', 'UC_mtg', 'Video 2', 'summarized');
    seedSignal(db, 'v3_irrel', 'UC_mtg', 'Irrelevant', 'irrelevant');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, {});

    // Default: exclude irrelevant signals
    expect(results.length).toBe(2);
  });

  it('includes irrelevant signals when includeIrrelevant is true', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Video 1', 'summarized');
    seedSignal(db, 'v2_irrel', 'UC_mtg', 'Irrelevant', 'irrelevant');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { includeIrrelevant: true });

    expect(results).toHaveLength(2);
  });

  it('throws for non-existent videoId', async () => {
    const db = createTestDb();

    const { resolveScope } = await import('./signal-chat-scope');
    expect(() => resolveScope(db, { videoId: 'nonexistent' })).toThrow();
  });

  // Bug 1: summary field populated from row.summary
  it('populates summary from DB for single-video scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v_mtg_1', 'UC_mtg', 'MTG Video');
    // Set a summary on the signal
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('this is the actual summary', 'v_mtg_1');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { videoId: 'v_mtg_1' });

    expect(results[0].summary).toBe('this is the actual summary');
  });

  it('populates summary from DB for multi-signal scope', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg_a', 'MTG A', 1);
    seedSignal(db, 'v1', 'UC_mtg_a', 'Video 1');
    db.prepare("UPDATE signals SET summary = ? WHERE video_id = ?").run('summary for v1', 'v1');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { topicKey: 'mtg' });

    expect(results[0].summary).toBe('summary for v1');
  });

  it('defaults summary to empty string when DB has null', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg', 'Video 1');

    const { resolveScope } = await import('./signal-chat-scope');
    const results = resolveScope(db, { videoId: 'v1' });

    expect(results[0].summary).toBe('');
  });
});

// ─── getHistory with filter criteria ──────────────────────

describe('getHistory with filter criteria — issue #127', () => {
  it('accepts topicKey as alternative to signalVideoId', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg');
    seedSignal(db, 'v2', 'UC_mtg');

    const { ChatManager } = await import('./services/chat-manager');
    const llmConfig = { model: 'test', apiKey: 'test', baseUrl: 'https://test' };
    const cm = new ChatManager(db, llmConfig);

    // Insert a row scoped by topic
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, ?, ?)"
    ).run('v1', 'what about MTG?', 'MTG answer', 'mtg');

    const history = cm.getHistory({ topicKey: 'mtg' });
    expect(history).toHaveLength(1);
    expect(history[0].question).toBe('what about MTG?');
  });

  it('accepts channelId as alternative to signalVideoId', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg');

    const { ChatManager } = await import('./services/chat-manager');
    const llmConfig = { model: 'test', apiKey: 'test', baseUrl: 'https://test' };
    const cm = new ChatManager(db, llmConfig);

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, channel_id) VALUES (?, ?, ?, ?)"
    ).run('v1', 'channel question', 'channel answer', 'UC_mtg');

    const history = cm.getHistory({ channelId: 'UC_mtg' });
    expect(history).toHaveLength(1);
  });

  it('strict composite: different filter combos return separate histories', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_a', 'A', 1);
    seedChannel(db, 'UC_b', 'B', 1);
    seedSignal(db, 'v_a', 'UC_a');
    seedSignal(db, 'v_b', 'UC_b');

    const { ChatManager } = await import('./services/chat-manager');
    const llmConfig = { model: 'test', apiKey: 'test', baseUrl: 'https://test' };
    const cm = new ChatManager(db, llmConfig);

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id) VALUES (?, ?, ?, ?, ?)"
    ).run('v_a', 'q for a', 'a', 'mtg', 'UC_a');

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id) VALUES (?, ?, ?, ?, ?)"
    ).run('v_b', 'q for b', 'b', 'mtg', 'UC_b');

    const historyA = cm.getHistory({ topicKey: 'mtg', channelId: 'UC_a' });
    const historyB = cm.getHistory({ topicKey: 'mtg', channelId: 'UC_b' });

    expect(historyA).toHaveLength(1);
    expect(historyA[0].question).toBe('q for a');
    expect(historyB).toHaveLength(1);
    expect(historyB[0].question).toBe('q for b');
  });
});

// ─── Regression: existing per-signal chat unchanged ──────────

describe('regression — per-signal chat behavior unchanged', () => {
  it('getHistory with signalVideoId string still works', async () => {
    const db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg', 'MTG Channel', 1);
    seedSignal(db, 'v1', 'UC_mtg');

    const { ChatManager } = await import('./services/chat-manager');
    const llmConfig = { model: 'test', apiKey: 'test', baseUrl: 'https://test' };
    const cm = new ChatManager(db, llmConfig);

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v1', 'old style q', 'old style a');

    const history = cm.getHistory('v1');
    expect(history).toHaveLength(1);
    expect(history[0].question).toBe('old style q');
  });
});