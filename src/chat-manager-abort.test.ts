import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock callLlmSync so tests don't hit real LLM
const mockCallLlmSync = vi.fn();

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    callLlmSync: (...args: unknown[]) => mockCallLlmSync(...args),
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

    // Insert a pending row (single-signal: signal_video_id set, no topic_key/channel_id)
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Create an already-aborted signal
    const controller = new AbortController();
    controller.abort();

    mockCallLlmSync.mockResolvedValue('this should not be persisted');

    // Process with aborted signal — should NOT write answer
    await chatManager.process(chatId, { abortSignal: controller.signal });

    // Answer must still be NULL (no DB write after abort check)
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  it('process() with pre-aborted signal skips DB write for multi-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    // Insert a pending row (multi-signal: topic_key set)
    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'compare all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    // Create an already-aborted signal
    const controller = new AbortController();
    controller.abort();

    mockCallLlmSync.mockResolvedValue('multi-signal answer that should not persist');

    await chatManager.process(chatId, { abortSignal: controller.signal });

    // Answer must still be NULL
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  it('process() threads abortSignal into callLlmSync for single-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    mockCallLlmSync.mockResolvedValue('normal answer');

    await chatManager.process(chatId, { abortSignal: controller.signal });

    // callLlmSync must have been called with options including abortSignal
    expect(mockCallLlmSync).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it('process() threads abortSignal into callLlmSync for multi-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'compare all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    mockCallLlmSync.mockResolvedValue('multi answer');

    await chatManager.process(chatId, { abortSignal: controller.signal });

    expect(mockCallLlmSync).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it('process() with no signal works as before (no regression)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    mockCallLlmSync.mockResolvedValue('normal answer');

    await chatManager.process(chatId);

    // Answer should be persisted (no signal = normal behavior)
    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.is_formatted).toBe(1);
  });

  it('process() propagates AbortError from callLlmSync', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockCallLlmSync.mockRejectedValue(abortError);

    await expect(chatManager.process(chatId, { abortSignal: controller.signal }))
      .rejects.toThrow('aborted');

    // Answer must still be NULL (error prevented write)
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });
});