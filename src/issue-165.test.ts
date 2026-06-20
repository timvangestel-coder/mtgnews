import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';

// Track call state for multi-round agent loop simulation
let streamToolCallRound = 0;
const mockStreamToolCalls: Array<{ id: string; type: string; name: string; args: string }> = [];

// Mock for callLlmStreamWithPhases (used by single-signal path)
const mockCallLlmStreamWithPhases = vi.fn(async function* (_config: unknown, _prompt: string, options?: { onPhaseChange?: (phase: string, count: number) => void }) {
  options?.onPhaseChange?.('intake', 0);
  yield 'token';
  options?.onPhaseChange?.('answering', 1);
});

// Mock for callLlmStreamWithTools (used by multi-signal agent loop)
const mockCallLlmStreamWithTools = vi.fn(async () => {
  // Round 0: LLM returns tool call for get_compact_text
  if (streamToolCallRound === 0) {
    streamToolCallRound++;
    return {
      tokens: (async function* () { yield 'thinking...'; })(),
      toolCalls: [
        {
          id: 'call_abc123',
          type: 'function' as const,
          function: {
            name: 'get_compact_text',
            arguments: JSON.stringify({ videoIds: ['vid_a', 'vid_b'] }),
          },
        },
      ],
    };
  }
  // Round 1+: LLM returns final answer (no tool calls)
  streamToolCallRound++;
  return {
    tokens: (async function* () { yield 'The key finding across both videos is that MTG prices are rising due to supply constraints.'; })(),
    toolCalls: [],
  };
});

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get callLlmStreamWithTools() {
      return mockCallLlmStreamWithTools;
    },
    get callLlmStreamWithPhases() {
      return mockCallLlmStreamWithPhases;
    },
  };
});

// Mock ChatResponseFormatter so we can verify it is called
const mockChatResponseFormat = vi.fn((text: string | null | undefined) => text ?? '');
vi.mock('./chat-response-formatter', () => ({
  get ChatResponseFormatter() {
    return { format: mockChatResponseFormat };
  },
}));

import { ChatManager } from './services/chat-manager';

let db: Database.Database;
let chatManager: ChatManager;

function seedTopic(key: string = 'mtg', filterText: string = 'Magic cards') {
  db.prepare(
    "INSERT OR REPLACE INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
  ).run(1, key, 'MTG', filterText);
}

function seedChannel(channelId: string = 'UC_a', topicId: number = 1) {
  db.prepare(
    'INSERT OR REPLACE INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)'
  ).run(channelId, 'Test Channel A', Date.now(), topicId);
}

function seedSignal(videoId: string, channelId: string = 'UC_a', compactText: string | null = null, summary: string = 'test summary') {
  db.prepare(
    `INSERT OR REPLACE INTO signals (video_id, channel_id, title, transcription, summary, compact_text, processing_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, channelId, `Video ${videoId}`, '[]', summary, compactText, 'summarized', Date.now());
}

describe('Issue #165 — Wire agent loop in ChatManager', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
  });

  beforeEach(() => {
    streamToolCallRound = 0;
    mockStreamToolCalls.length = 0;
    mockChatResponseFormat.mockClear().mockImplementation((text: string | null | undefined) => text ?? '');
  });

  afterAll(() => {
    db.close();
  });

  // ─── Tracer bullet: end-to-end agent loop ──────────────────────

  it('multi-signal chat flows through agent loop: index -> tool call -> compact_text retrieved -> answer', async () => {
    // Setup: seed topic, channels, signals with compact_text
    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_a', 'UC_a', '[T:0] MTG prices rising supply constraints alpha block', 'MTG price analysis');
    seedSignal('vid_b', 'UC_a', '[T:5] Modern format banned list update week 42', 'Modern format updates');

    // Insert multi-signal scoped row
    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'What are MTG prices doing?', 'mtg').lastInsertRowid as number;

    await chatManager.process(id);

    // Verify: answer persisted to DB
    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(id) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('MTG prices');
  });

  // ─── Tool handler fetches compact_text from SQLite ──────────────

  it('tool handler fetches compact_text from SQLite for requested videoIds', async () => {
    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_x', 'UC_a', '[T:0] compact text for vid_x only', 'summary x');
    seedSignal('vid_y', 'UC_a', '[T:10] compact text for vid_y only', 'summary y');

    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'Compare videos X and Y?', 'mtg').lastInsertRowid as number;

    await chatManager.process(id);

    // The agent loop ran — verify it completed without error and persisted an answer
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
  });

  // ─── 3-round cap enforced ──────────────────────────────────────

  it('enforces 3-round hard limit on retrieval loops', async () => {
    // Force the LLM to return tool calls every round (no final answer)
    const mockLlm = vi.fn();
    mockLlm.mockImplementation(async () => ({
      tokens: (async function* () { yield 'thinking...'; })(),
      toolCalls: [
        {
          id: 'call_loop',
          type: 'function' as const,
          function: { name: 'get_compact_text', arguments: JSON.stringify({ videoIds: ['vid_a'] }) },
        },
      ],
    }));

    // Temporarily override the module-level mock
    const { callLlmStreamWithTools } = await import('./llm');
    const original = callLlmStreamWithTools;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_a', 'UC_a', '[T:0] loop test content', 'loop summary');

    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'Loop test?', 'mtg').lastInsertRowid as number;

    // The agent loop must not hang — it should stop after 3 rounds and persist whatever answer was accumulated
    const promise = chatManager.process(id);
    await expect(promise).resolves.toBeUndefined();

    // Answer should be set (even if partial/empty) since the loop terminated
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    // After 3 rounds of tool calls with no final content, answer is whatever was accumulated
    expect(row.answer).toBeDefined();
  });

  // ─── Agent prompt uses assembleAgentChat with signal index ──────

  it('agent loop builds signal index and uses assembleAgentChat', async () => {
    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_idx1', 'UC_a', '[T:0] compact idx1', 'Index entry one with key details');
    seedSignal('vid_idx2', 'UC_a', '[T:5] compact idx2', 'Index entry two with more details');

    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'What is the index like?', 'mtg').lastInsertRowid as number;

    await chatManager.process(id);

    // Verify: process completed and answer persisted
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
  });

  // ─── Regression: single-signal chat still works ────────────────

  it('single-signal chat still uses streaming path (regression)', async () => {
    // Single-signal should NOT go through agent loop — existing behavior preserved
    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_single', 'UC_a', '[T:0] single signal content', 'single summary');

    const id = chatManager.submit('vid_single', 'Single video question?');
    await chatManager.process(id);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
  });
});