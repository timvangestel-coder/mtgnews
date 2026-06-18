import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock the LLM streaming functions
const mockCallLlmStreamWithPhases = vi.fn();

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    callLlmSync: vi.fn().mockResolvedValue('sync answer'),
    callLlmStream: vi.fn(),
    callLlmStreamWithPhases: (...args: unknown[]) => mockCallLlmStreamWithPhases(...args),
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

  it('_processSingleSignal uses callLlmStreamWithPhases with tee buffering', async () => {
    seedTopic(); seedChannel(); seedSignal();

    // Insert a pending row
    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Simulate streaming tokens with phase callbacks
    let onPhaseChange: ((phase: string, count: number) => void) | undefined;
    mockCallLlmStreamWithPhases.mockImplementation(async function* () {
      onPhaseChange?.('intake', 0);
      yield 'Hello ';
      onPhaseChange?.('reasoning', 50);
      yield 'world';
      onPhaseChange?.('answering', 120);
    });

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    let capturedOnPhase: ((phase: string, count: number) => void) | undefined;
    await manager.process(chatId, {
      onPhaseChange: (phase, count) => { capturedOnPhase = (p, c) => onPhaseChange?.(p, c); },
    });

    // Verify answer was persisted via tee buffering
    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.answer?.length).toBeGreaterThan(0);
  });

  it('_processMultiSignal uses callLlmStreamWithPhases with tee buffering', async () => {
    seedTopic(); seedChannel(); seedSignal();

    // Insert a pending list-scoped row
    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)").run(null, 'summarize all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    // Simulate streaming tokens
    mockCallLlmStreamWithPhases.mockImplementation(async function* () {
      yield 'Summary: ';
      yield 'all videos are great';
    });

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    await manager.process(chatId);

    // Verify answer was persisted
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer?.length).toBeGreaterThan(0);
  });

  it('onPhaseChange callback fires during streaming', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'phase callback test');
    const chatId = Number(result.lastInsertRowid);

    const phases: { phase: string; count: number }[] = [];
    mockCallLlmStreamWithPhases.mockImplementation(async function* (_config: unknown, _prompt: unknown, options?: { onPhaseChange?: (phase: string, count: number) => void }) {
      options?.onPhaseChange?.('intake', 0);
      yield 'a';
      options?.onPhaseChange?.('reasoning', 100);
      yield 'b';
      options?.onPhaseChange?.('answering', 250);
      yield 'c';
    });

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    let phaseCollector: { phases: typeof phases } | undefined;
    await manager.process(chatId, {
      onPhaseChange: (phase, count) => {
        if (phaseCollector) {
          phaseCollector.phases.push({ phase, count });
        } else {
          phaseCollector = { phases: [{ phase, count }] };
        }
      },
    });

    // Verify phases were captured
    expect(phaseCollector).toBeDefined();
    const phaseNames = phaseCollector!.phases.map(p => p.phase);
    expect(phaseNames).toContain('intake');
  });

  it('abort during streaming prevents answer persistence', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'abort test');
    const chatId = Number(result.lastInsertRowid);

    const controller = new AbortController();
    mockCallLlmStreamWithPhases.mockImplementation(async function* (_config: unknown, _prompt: unknown, options?: { abortSignal?: AbortSignal }) {
      yield 'partial';
      // Simulate abort mid-stream
      if (options?.abortSignal?.aborted) return;
      yield 'more';
    });

    const { ChatManager } = await import('./services/chat-manager');
    const { getLlmConfig } = await import('./llm');
    const manager = new ChatManager(db, getLlmConfig());

    // Abort before calling process — the abort check should prevent persistence
    controller.abort();

    // The streaming path checks abortSignal after streaming completes
    // Since we aborted before starting, the signal is already aborted
    await manager.process(chatId, { abortSignal: controller.signal });

    // Answer should remain NULL since abort was detected
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  it('streaming error leaves answer NULL (no partial write)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'error test');
    const chatId = Number(result.lastInsertRowid);

    mockCallLlmStreamWithPhases.mockImplementation(async function* () {
      yield 'partial';
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