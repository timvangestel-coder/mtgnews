import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock callLlmStreamWithTools so tests don't hit real LLM
let mockTokens: AsyncGenerator<string>;
const mockCallLlmStreamWithTools = vi.fn();

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    get callLlmStreamWithTools() {
      return mockCallLlmStreamWithTools;
    },
  };
});

let ChatManager: typeof import('./services/chat-manager').ChatManager;
let getLlmConfigFn: () => import('./llm').LlmConfig;

describe('Issue #167 - Streaming integration + answer persistence', () => {
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
    db.prepare("INSERT INTO signals (video_id, channel_id, title, published_at, transcription, compact_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      videoId, channelId, 'Test Video', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test transcript' }]), 'compact content', Date.now()
    );
  }

  /* Tracer bullet: onToken callback fires during process() */

  it('process() delivers tokens via onToken callback for single-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // No tool calls - final answer with tokens "hello world"
    mockTokens = (async function* () { yield 'hello '; yield 'world'; })();
    mockCallLlmStreamWithTools.mockResolvedValue({ tokens: mockTokens, toolCalls: [] });

    const receivedTokens: string[] = [];
    await chatManager.process(chatId, {
      onToken: (token) => receivedTokens.push(token),
    });

    expect(receivedTokens).toEqual(['hello ', 'world']);
  });

  /* Streaming retrieval thoughts during Round 1 */

  it('process() streams retrieval reasoning tokens when tool calls present', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Round 1: retrieval reasoning with tool calls
    mockTokens = (async function* () { yield 'Let '; yield 'me '; yield 'check '; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({
      tokens: mockTokens,
      toolCalls: [{ id: 'call_1', function: { name: 'get_compact_text', arguments: '{"videoIds":["vid_1"]}' } }],
    });

    // Round 2: final answer - no tool calls
    mockTokens = (async function* () { yield 'The '; yield 'answer '; yield 'is '; yield '42'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({ tokens: mockTokens, toolCalls: [] });

    const receivedTokens: string[] = [];
    await chatManager.process(chatId, {
      onToken: (token) => receivedTokens.push(token),
    });

    // Both retrieval reasoning AND final answer streamed to UI
    expect(receivedTokens).toContain('Let ');
    expect(receivedTokens).toContain('check ');
    expect(receivedTokens).toContain('The ');
    expect(receivedTokens).toContain('42');
  });

  /* Only final answer persisted (no retrieval reasoning) */

  it('process() persists only final answer - retrieval reasoning excluded from DB', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Round 1: retrieval reasoning with tool calls
    mockTokens = (async function* () { yield 'Let '; yield 'me '; yield 'check '; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({
      tokens: mockTokens,
      toolCalls: [{ id: 'call_1', function: { name: 'get_compact_text', arguments: '{"videoIds":["vid_1"]}' } }],
    });

    // Round 2: final answer - no tool calls
    mockTokens = (async function* () { yield 'The '; yield 'answer '; yield 'is '; yield '42'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({ tokens: mockTokens, toolCalls: [] });

    await chatManager.process(chatId);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).not.toBeNull();

    // Answer contains final answer content with citations applied
    expect(row.answer!).toContain('42');

    // Answer does NOT contain retrieval reasoning text
    expect(row.answer!).not.toContain('Let me check');
  });

  /* Multi-signal: same behavior for scoped chat */

  it('process() persists only final answer for multi-signal', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
    ).run(null, 'compare all', 'tech');
    const chatId = Number(result.lastInsertRowid);

    // Round 1: retrieval reasoning with tool calls
    mockTokens = (async function* () { yield 'Checking '; yield 'signals...'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({
      tokens: mockTokens,
      toolCalls: [{ id: 'call_1', function: { name: 'get_compact_text', arguments: '{"videoIds":["vid_1"]}' } }],
    });

    // Round 2: final answer - no tool calls
    mockTokens = (async function* () { yield 'Both '; yield 'videos '; yield 'agree'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({ tokens: mockTokens, toolCalls: [] });

    await chatManager.process(chatId);

    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(chatId) as { answer: string | null };
    expect(row.answer).not.toBeNull();
    expect(row.answer!).toContain('agree');
    expect(row.answer!).not.toContain('Checking signals');
  });

  /* Chat history shows clean answers on reload */

  it('getHistory returns only final answer without retrieval reasoning', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Round 1: retrieval reasoning with tool calls
    mockTokens = (async function* () { yield 'Thinking...'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({
      tokens: mockTokens,
      toolCalls: [{ id: 'call_1', function: { name: 'get_compact_text', arguments: '{"videoIds":["vid_1"]}' } }],
    });

    // Round 2: final answer - no tool calls
    mockTokens = (async function* () { yield 'Final '; yield 'answer'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({ tokens: mockTokens, toolCalls: [] });

    await chatManager.process(chatId);

    const history = chatManager.getHistory('vid_1');
    expect(history).toHaveLength(1);
    // Answer in history must not contain retrieval reasoning
    expect(history[0].answer!).not.toContain('Thinking...');
  });

  /* Status polling: retrieving phase reported correctly */

  it('process() reports phases via onPhaseChange during agent loop', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const chatManager = new ChatManager(db, getLlmConfigFn());

    const result = db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)"
    ).run('vid_1', 'what is this?');
    const chatId = Number(result.lastInsertRowid);

    // Round 1: tool calls - should fire intake phase
    mockTokens = (async function* () { yield 'checking'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({
      tokens: mockTokens,
      toolCalls: [{ id: 'call_1', function: { name: 'get_compact_text', arguments: '{"videoIds":["vid_1"]}' } }],
    });

    // Round 2: no tool calls - final answer
    mockTokens = (async function* () { yield 'done'; })();
    mockCallLlmStreamWithTools.mockResolvedValueOnce({ tokens: mockTokens, toolCalls: [] });

    const phases: Array<{ phase: string; tokenCount: number }> = [];
    await chatManager.process(chatId, {
      onPhaseChange: (phase, tokenCount) => phases.push({ phase, tokenCount }),
    });

    // Round 0 fires intake, final round fires answering
    expect(phases[0].phase).toBe('intake');
    expect(phases[phases.length - 1].phase).toBe('answering');
  });
});