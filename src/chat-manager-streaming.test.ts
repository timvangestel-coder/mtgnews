import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock the LLM streaming functions
const mockCallLlmStreamWithPhases = vi.fn();
// Mock for tool-calling path used by multi-signal agent loop (issue #165)
const mockCallLlmStreamWithTools = vi.fn(async () => ({
  tokens: (async function* () { yield 'Summary: '; yield 'all videos are great'; })(),
  toolCalls: [],
}));

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    callLlmSync: vi.fn().mockResolvedValue('sync answer'),
    callLlmStream: vi.fn(),
    callLlmStreamWithPhases: (...args: unknown[]) => mockCallLlmStreamWithPhases(...args),
    get callLlmStreamWithTools() {
      return mockCallLlmStreamWithTools;
    },
    getLlmConfig: actual.getLlmConfig,
  };
});

describe('ChatManager streaming migration (issue #157)', () => {
  let db: Database.Database;

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

  // Issue #166: single-signal now uses agent loop with callLlmStreamWithTools
  it('_processSingleSignal uses agent loop (callLlmStreamWithTools) and persists answer', async () => {
    seedTopic(); seedChannel(); seedSignal();

    // Insert a pending row
    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    await manager.process(chatId);

    // Verify callLlmStreamWithTools was called (agent path)
    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();

    // Verify answer was persisted via tee buffering
    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.is_formatted).toBe(1);
  });

  // Issue #165: multi-signal now uses agent loop with callLlmStreamWithTools instead of callLlmStreamWithPhases
  it('_processMultiSignal uses agent loop (callLlmStreamWithTools) and persists answer', async () => {
    seedTopic(); seedChannel(); seedSignal();

    // Insert a pending list-scoped row
    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)").run(null, 'summarize all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    // Default mockCallLlmStreamWithTools returns tokens + no tool calls -> final answer path

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    await manager.process(chatId);

    // Verify callLlmStreamWithTools was called (agent path)
    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();

    // Verify answer was persisted
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer?.length).toBeGreaterThan(0);
  });

  it('onPhaseChange callback fires during agent loop', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'phase callback test');
    const chatId = Number(result.lastInsertRowid);

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    const phases: { phase: string; count: number }[] = [];
    await manager.process(chatId, {
      onPhaseChange: (phase, count) => {
        phases.push({ phase, count });
      },
    });

    // Verify phases were captured — agent loop fires 'intake' for round 0 and 'answering' at end
    expect(phases.length).toBeGreaterThan(0);
    const phaseNames = phases.map(p => p.phase);
    expect(phaseNames).toContain('intake');
  });

  it('abort during agent loop prevents answer persistence', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'abort test');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    // Abort before calling process — agent loop checks abortSignal before first round
    controller.abort();

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    await manager.process(chatId, { abortSignal: controller.signal });

    // Answer should remain NULL since abort was detected before LLM call
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  // Issue #166: single-signal now uses agent loop — streaming error via callLlmStreamWithTools
  it('streaming error leaves answer NULL (no partial write)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'error test');
    const chatId = Number(result.lastInsertRowid);

    mockCallLlmStreamWithTools.mockImplementation(async () => {
      throw new Error('LLM stream failed');
    });

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    await expect(manager.process(chatId)).rejects.toThrow('LLM stream failed');

    // Answer should remain NULL on error
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });
});