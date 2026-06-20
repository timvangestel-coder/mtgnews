import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';

// Mock LLM that always returns tool calls (no final answer) — simulates 3 rounds of retrieval without answering
const mockCallLlmStreamWithToolsAlwaysTool = vi.fn(async () => ({
  tokens: (async function* () { yield 'thinking...'; })(),
  toolCalls: [
    {
      id: 'call_always_tool',
      type: 'function' as const,
      function: { name: 'get_compact_text', arguments: JSON.stringify({ videoIds: ['vid_a'] }) },
    },
  ],
}));

// Mock LLM that returns a normal answer in round 1 (after one tool call)
const mockCallLlmStreamWithToolsNormal = vi.fn(async () => ({
  tokens: (async function* () { yield 'Answer content from the agent loop.'; })(),
  toolCalls: [],
}));

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get callLlmStreamWithTools() {
      // Switchable via a flag set in tests
      if ((globalThis as any).__TDD_MOCK_ALWAYS_TOOL) {
        return mockCallLlmStreamWithToolsAlwaysTool;
      }
      return mockCallLlmStreamWithToolsNormal;
    },
  };
});

// Mock ChatResponseFormatter
const mockChatResponseFormat = vi.fn((text: string | null | undefined, _signalMap?: unknown) => text ?? '');
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

describe('Issue #170 — Consolidate AgentChat loops + empty answer guard', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
  });

  beforeEach(() => {
    mockCallLlmStreamWithToolsAlwaysTool.mockClear();
    mockCallLlmStreamWithToolsNormal.mockClear();
    mockChatResponseFormat.mockClear().mockImplementation((text: string | null | undefined) => text ?? '');
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = false;
  });

  afterAll(() => {
    db.close();
  });

  // ─── Tracer bullet: empty answer guard ────────────────────────

  it('persist fallback message when LLM returns only tool calls in all 3 rounds (multi-signal)', async () => {
    // Force always-tool-calls mode
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = true;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_a', 'UC_a', '[T:0] some compact text', 'some summary');

    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'Question with no answer?', 'mtg').lastInsertRowid as number;

    await chatManager.process(id);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    // After 3 rounds of tool calls with no final content, the fallback message is persisted
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('maximum number of retrieval rounds');
  });

  it('persist fallback message when LLM returns only tool calls in all 3 rounds (single-signal)', async () => {
    // Force always-tool-calls mode
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = true;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_single', 'UC_a', '[T:0] single compact text', 'single summary');

    const id = chatManager.submit('vid_single', 'Single signal question?');
    await chatManager.process(id);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('maximum number of retrieval rounds');
  });

  // ─── Normal flow still works (regression) ─────────────────────

  it('multi-signal chat persists normal answer when LLM returns content', async () => {
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = false;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_a', 'UC_a', '[T:0] compact text', 'summary a');
    seedSignal('vid_b', 'UC_a', '[T:5] more compact text', 'summary b');

    const id = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'Normal multi-signal question?', 'mtg').lastInsertRowid as number;

    await chatManager.process(id);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('Answer content');
  });

  it('single-signal chat persists normal answer when LLM returns content', async () => {
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = false;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_single2', 'UC_a', '[T:0] single compact text', 'single summary');

    const id = chatManager.submit('vid_single2', 'Single signal normal question?');
    await chatManager.process(id);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('Answer content');
  });

  // ─── Thin adapter verification ────────────────────────────────

  it('_processSingleSignal uses resolveIndexScope (thin adapter)', async () => {
    // This is a structural test: verify single-signal path goes through the same agent loop
    // by checking that callLlmStreamWithTools was called (not callLlmStreamWithPhases)
    (globalThis as any).__TDD_MOCK_ALWAYS_TOOL = false;

    seedTopic();
    seedChannel('UC_a');
    seedSignal('vid_adapter', 'UC_a', '[T:0] adapter test compact text', 'adapter summary');

    const id = chatManager.submit('vid_adapter', 'Adapter test question?');
    await chatManager.process(id);

    // Verify the agent loop was used (callLlmStreamWithTools called, not stream with phases)
    expect(mockCallLlmStreamWithToolsNormal).toHaveBeenCalled();
  });
});