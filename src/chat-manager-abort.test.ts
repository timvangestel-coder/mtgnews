import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock callLlmStreamWithPhases so tests don't hit real LLM
const mockCallLlmStreamWithPhases = vi.fn();
// Mock for tool-calling path used by multi-signal agent loop (issue #165)
let lastToolCallOptions: unknown;
const mockCallLlmStreamWithTools = vi.fn(async (_config, _prompt, _tools, options) => {
  lastToolCallOptions = options;
  return {
    tokens: (async function* () { yield 'token'; })(),
    toolCalls: [],
  };
});

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    callLlmStreamWithPhases: (...args: unknown[]) => mockCallLlmStreamWithPhases(...args),
    get callLlmStreamWithTools() {
      return mockCallLlmStreamWithTools;
    },
  };
});

let ChatManager: typeof import('./services/chat-manager').ChatManager;
let getLlmConfigFn: () => import('./llm').LlmConfig;

describe('ChatManager AbortSignal seam', () => {
  let db: Database.Database;

  beforeAll(async () => {
    const cm = await import('./services/chat-manager');
    ChatManager = cm.ChatManager;
    const llm = await import('./llm');
    getLlmConfigFn = llm.getLlmConfig;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
  });

  afterAll(() => db.close());

  function seedTopic(id: number = 1) {
    db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(id, 'tech', 'tech', 'tech');
  }
  function seedChannel(channelId: string = 'UC_test', topicId: number = 1) {
    db.prepare("INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)").run(channelId, 'Test Channel', Date.now(), topicId);
  }
  function seedSignal(videoId: string = 'vid_1', channelId: string = 'UC_test') {
    db.prepare("INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      videoId, channelId, 'Test Video', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test transcript' }]), Date.now()
    );
  }

  /* ─── Issue #141: AbortSignal seam through ChatManager.process() ─── */

  it('process() with pre-aborted signal skips DB write for single-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Streaming mock that yields a token then checks abort
    mockCallLlmStreamWithPhases.mockImplementation(async function* (config, prompt, options) {
      yield 'partial';
      if (options?.abortSignal?.aborted) return;
      yield 'more';
    });

    // Create an already-aborted signal
    const controller = new AbortController();
    controller.abort();

    // Process with aborted signal — abort check after stream prevents DB write
    await chatManager.process(chatId, { abortSignal: controller.signal });

    // Answer must still be NULL (abort detected before persist)
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  // Issue #165: multi-signal now uses agent loop with callLlmStreamWithTools
  it('process() with pre-aborted signal skips DB write for multi-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'compare all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    // Agent loop checks abortSignal before first round — pre-aborted skips immediately

    const controller = new AbortController();
    controller.abort();

    await chatManager.process(chatId, { abortSignal: controller.signal });

    // Answer must still be NULL (abort detected before persist)
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  // Issue #166: single-signal now uses agent loop with callLlmStreamWithTools
  it('process() threads abortSignal into callLlmStreamWithTools for single-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    await chatManager.process(chatId, { abortSignal: controller.signal });

    // callLlmStreamWithTools must have been called with options including abortSignal
    expect(lastToolCallOptions).toBeDefined();
    expect((lastToolCallOptions as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);
  });

  // Issue #165: multi-signal uses agent loop with callLlmStreamWithTools
  it('process() threads abortSignal into callLlmStreamWithTools for multi-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'compare all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    await chatManager.process(chatId, { abortSignal: controller.signal });

    // callLlmStreamWithTools must have been called with options including abortSignal
    expect(lastToolCallOptions).toBeDefined();
    expect((lastToolCallOptions as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);
  });

  it('process() with no signal works as before (no regression)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    mockCallLlmStreamWithPhases.mockImplementation(async function* () {
      yield 'token';
    });

    await chatManager.process(chatId);

    // Answer should be persisted (no signal = normal behavior)
    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.is_formatted).toBe(1);
  });

  // Issue #166: single-signal now uses agent loop — abort error propagates via callLlmStreamWithTools
  it('process() propagates AbortError from stream', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockCallLlmStreamWithTools.mockImplementation(async () => {
      throw abortError;
    });

    await expect(chatManager.process(chatId, { abortSignal: controller.signal }))
      .rejects.toThrow('aborted');

    // Answer must still be NULL (error prevented write)
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });
});