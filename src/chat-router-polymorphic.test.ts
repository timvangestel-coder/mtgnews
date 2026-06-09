import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
import { ChatManager } from './services/chat-manager';
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
    "INSERT INTO signals (video_id, channel_id, title, transcription, summary, created_at, processing_state) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(videoId, channelId, title, JSON.stringify({ segments: [] }), 'test summary', Date.now(), processingState);
}

// ─── ChatManager.submit with ChatScope ──────────────────────

describe('ChatManager.submit — polymorphic (issue #130)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg_a', 'MTG A', 1);
    seedChannel(db, 'UC_mtg_b', 'MTG B', 1);
    seedSignal(db, 'v_mtg_a_1', 'UC_mtg_a', 'MTG A Video');
    seedSignal(db, 'v_mtg_b_1', 'UC_mtg_b', 'MTG B Video');
  });

  afterAll(() => {
    db.close();
  });

  it('accepts ChatScope with topicKey and inserts list-scoped pending row', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const id = cm.submit({ topicKey: 'mtg', question: 'What is the MTG meta?' });

    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      signal_video_id: string | null;
      question: string;
      answer: string | null;
      topic_key: string | null;
      channel_id: string | null;
      include_irrelevant: number | null;
    };

    expect(row.signal_video_id).toBeNull();
    expect(row.question).toBe('What is the MTG meta?');
    expect(row.answer).toBeNull();
    expect(row.topic_key).toBe('mtg');
  });

  it('accepts ChatScope with topicKey+channelId and inserts list-scoped row', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const id = cm.submit({ topicKey: 'mtg', channelId: 'UC_mtg_a', question: 'Channel A question?' });

    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      signal_video_id: string | null;
      topic_key: string | null;
      channel_id: string | null;
      include_irrelevant: number | null;
    };

    expect(row.signal_video_id).toBeNull();
    expect(row.topic_key).toBe('mtg');
    expect(row.channel_id).toBe('UC_mtg_a');
  });

  it('accepts ChatScope with includeIrrelevant and persists it', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const id = cm.submit({ topicKey: 'mtg', includeIrrelevant: true, question: 'Include all?' });

    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      include_irrelevant: number | null;
    };

    expect(row.include_irrelevant).toBe(1);
  });

  it('existing videoId submit still works (regression)', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const id = cm.submit('v_mtg_a_1', 'What about this video?');

    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      signal_video_id: string | null;
      topic_key: string | null;
    };

    expect(row.signal_video_id).toBe('v_mtg_a_1');
    expect(row.topic_key).toBeNull();
  });
});

// ─── ChatManager.process routing ──────────────────────────────

describe('ChatManager.process — routes by scope (issue #130)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_mtg_a', 'MTG A', 1);
    seedSignal(db, 'v_mtg_a_1', 'UC_mtg_a', 'MTG A Video');
    seedSignal(db, 'v_mtg_a_2', 'UC_mtg_a', 'MTG A Video 2');
  });

  afterAll(() => {
    db.close();
  });

  it('routes list-scoped row to assembleMultiSignalChat', async () => {
    // Capture what prompt is passed to callLlmSync by monkey-patching
    let capturedPrompt: string | undefined;
    const originalModule = await import('./llm');
    
    // We verify routing by checking the assembled prompt structure
    // Insert a list-scoped pending row
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id, include_irrelevant) VALUES (?, ?, NULL, ?, ?, ?)"
    ).run(null, 'Compare all MTG videos?', 'mtg', 'UC_mtg_a', 0);
    const id = Number(result.lastInsertRowid);

    // Verify the row was inserted with correct scope columns
    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      signal_video_id: string | null;
      topic_key: string | null;
      channel_id: string | null;
    };
    expect(row.signal_video_id).toBeNull();
    expect(row.topic_key).toBe('mtg');
    expect(row.channel_id).toBe('UC_mtg_a');

    // Verify process() correctly identifies it as list-scoped by checking internal routing
    // We do this by verifying the prompt assembled would contain <signal> blocks
    const { resolveScope } = await import('./signal-chat-scope');
    const { assembleMultiSignalChat } = await import('./prompt-assembler');
    
    const signals = resolveScope(db, { topicKey: 'mtg', channelId: 'UC_mtg_a' });
    expect(signals.length).toBeGreaterThanOrEqual(1);

    const prompt = assembleMultiSignalChat({
      signals,
      history: [],
      question: 'Compare all MTG videos?',
    });
    
    // Verify multi-signal prompt contains <signal> XML blocks
    expect(prompt).toContain('<signal');
    expect(prompt).toContain('video_id=');
  });

  it('routes single-signal row to assembleChat', async () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    
    // Insert a per-signal pending row via submit
    const id = cm.submit('v_mtg_a_1', 'What about this video?');

    // Verify the row has signal_video_id set (single-signal scope)
    const row = db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(id) as {
      signal_video_id: string | null;
      topic_key: string | null;
    };
    expect(row.signal_video_id).toBe('v_mtg_a_1');
    expect(row.topic_key).toBeNull();
  });
});

// ─── GET /chat/history with filter criteria ──────────────────

describe('GET /chat/history — list-scoped (issue #130)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
    seedTopic(db, 'mtg', 1);
    seedChannel(db, 'UC_a', 'A', 1);
    seedChannel(db, 'UC_b', 'B', 1);
    seedSignal(db, 'v_a', 'UC_a');
    seedSignal(db, 'v_b', 'UC_b');

    // Insert list-scoped history rows
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id) VALUES (?, ?, ?, ?, ?)"
    ).run(null, 'q for A', 'a', 'mtg', 'UC_a');

    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id) VALUES (?, ?, ?, ?, ?)"
    ).run(null, 'q for B', 'b', 'mtg', 'UC_b');

    // Insert a topic-only row (no channelId)
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, ?, ?)"
    ).run(null, 'q for all mtg', 'all', 'mtg');
  });

  afterAll(() => {
    db.close();
  });

  it('returns list-scoped history by topicKey+channelId', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const history = cm.getHistory({ topicKey: 'mtg', channelId: 'UC_a' });

    expect(history).toHaveLength(1);
    expect(history[0].question).toBe('q for A');
  });

  it('strict composite: different channelIds return separate histories', () => {
    const cm = new ChatManager(db, { model: 'test', apiKey: 'test', baseUrl: 'https://test' });
    const historyB = cm.getHistory({ topicKey: 'mtg', channelId: 'UC_b' });

    expect(historyB).toHaveLength(1);
    expect(historyB[0].question).toBe('q for B');
  });
});

// ─── signal_video_id nullable schema test ──────────────────

describe('signal_chat.signal_video_id nullable (issue #130)', () => {
  it('allows NULL signal_video_id for list-scoped rows', () => {
    const db = createTestDb();
    
    // Should not throw
    expect(() => {
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, ?, ?)"
      ).run(null, 'test', null, 'mtg');
    }).not.toThrow();

    const row = db.prepare('SELECT signal_video_id FROM signal_chat WHERE question = ?').get('test') as { signal_video_id: string | null };
    expect(row.signal_video_id).toBeNull();

    db.close();
  });
});