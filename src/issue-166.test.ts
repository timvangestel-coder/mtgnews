import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';

// Track what callLlmStreamWithTools receives
let lastAgentPrompt: string | undefined;
let lastTools: unknown[] = [];
let toolCallResponses: Array<{ name: string; args: string }> = [];
let mockCallCount = 0;

const mockCallLlmStreamWithTools = vi.fn(async (_config: unknown, prompt: string, tools?: unknown[]) => {
  lastAgentPrompt = prompt;
  lastTools = tools ?? [];

  // Use call count to decide: first N calls return tool calls (per toolCallResponses), rest return final answer
  const idx = mockCallCount;
  mockCallCount++;

  if (idx < toolCallResponses.length) {
    // Return a tool call
    return {
      tokens: (async function* () { yield ''; })(),
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: toolCallResponses[idx].name,
            arguments: toolCallResponses[idx].args,
          },
        },
      ],
    };
  }

  // No tool calls = final answer
  return {
    tokens: (async function* () { yield 'answer token'; })(),
    toolCalls: [],
  };
});

vi.mock('./llm', () => ({
  callLlmStream: async function* () {
    yield 'legacy token';
  },
  callLlmStreamWithPhases: async function* () {
    yield 'stream token';
  },
  get callLlmSync() {
    return vi.fn().mockResolvedValue('sync answer');
  },
  get callLlmStreamWithTools() {
    return mockCallLlmStreamWithTools;
  },
}));

const mockChatResponseFormat = vi.fn((text: string | null | undefined) => text ?? '');
vi.mock('./chat-response-formatter', () => ({
  get ChatResponseFormatter() {
    return { format: mockChatResponseFormat };
  },
}));

import { ChatManager } from './services/chat-manager';

let db: Database.Database;
let chatManager: ChatManager;

function insertSignal(videoId: string, compactText?: string) {
  db.prepare(
    `INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
  ).run(videoId + '_ch', 'Test Channel', Date.now());

  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, compact_text, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId, videoId + '_ch', 'Test Signal for ' + videoId,
    '2103-12-31T00:00:00Z', '[]', 'test summary about MTG',
    compactText ?? null, 4, Date.now()
  );
}

describe('Issue #166 — per-signal chat uses unified agent loop', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    insertSignal('vid-166-a', '[T:0] Kaldra set is good');
    insertSignal('vid-166-b', null); // no compact_text

    chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
  });

  beforeEach(() => {
    lastAgentPrompt = undefined;
    lastTools = [];
    toolCallResponses = [];
    mockCallCount = 0;
    mockCallLlmStreamWithTools.mockClear();
    mockChatResponseFormat.mockClear().mockImplementation((t) => t ?? '');
  });

  afterAll(() => {
    db.close();
  });

  it('uses agent loop (callLlmStreamWithTools) for single-signal chat', async () => {
    const id = chatManager.submit('vid-166-a', 'What about Kaldra?');
    await chatManager.process(id);

    // Must use agent path, not direct stream
    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();
    expect(lastAgentPrompt).toBeDefined();
    expect(lastAgentPrompt!).toContain('<signal_index>');
  });

  it('single-signal agent prompt contains exactly one index entry', async () => {
    const id = chatManager.submit('vid-166-a', 'Tell me about this video');
    await chatManager.process(id);

    expect(lastAgentPrompt!).toContain('video_id="vid-166-a"');
    // Must NOT contain the other signal's videoId
    expect(lastAgentPrompt!).not.toContain('vid-166-b');
  });

  it('agent prompt includes get_compact_text tool instruction', async () => {
    const id = chatManager.submit('vid-166-a', 'What is discussed?');
    await chatManager.process(id);

    expect(lastAgentPrompt!).toContain('get_compact_text');
  });

  it('tool definition passed to callLlmStreamWithTools has get_compact_text', async () => {
    const id = chatManager.submit('vid-166-a', 'q?');
    await chatManager.process(id);

    expect(lastTools.length).toBeGreaterThan(0);
    const toolDef = lastTools[0] as { type: string; function?: { name: string } };
    expect(toolDef.function?.name).toBe('get_compact_text');
  });

  it('old _processSingleSignal direct-injection path removed (no callLlmStreamWithPhases)', async () => {
    // The per-signal path must NOT use callLlmStreamWithPhases anymore.
    // We verify this by confirming the agent tool path is used instead.
    const id = chatManager.submit('vid-166-a', 'direct injection check');
    await chatManager.process(id);

    // Agent path was called — direct stream path is gone
    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();
  });

  it('per-signal agent loop handles LLM deciding no tool call needed', async () => {
    // LLM returns final answer without tool calls (answer from summary alone)
    toolCallResponses = []; // empty = mock returns no toolCalls immediately

    const id = chatManager.submit('vid-166-a', 'Quick question?');
    await chatManager.process(id);

    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
  });

  it('per-signal agent loop handles tool call then final answer', async () => {
    // Simulate: first LLM call requests compact_text, second returns answer
    toolCallResponses = [
      { name: 'get_compact_text', args: '{"videoIds":["vid-166-a"]}' },
    ];

    const id = chatManager.submit('vid-166-a', 'Detailed question?');
    await chatManager.process(id);

    // Two LLM calls: one for tool call, one for final answer
    expect(mockCallLlmStreamWithTools).toHaveBeenCalledTimes(2);
  });

  it('answer persisted to DB after agent loop completes', async () => {
    const id = chatManager.submit('vid-166-a', 'Persist test?');
    await chatManager.process(id);

    const row = db.prepare('SELECT answer, is_formatted FROM signal_chat WHERE id = ?').get(id) as { answer: string | null; is_formatted: number };
    expect(row.answer).not.toBeNull();
    expect(row.is_formatted).toBe(1);
  });

  it('ChatResponseFormatter called with signalMap for single-signal agent path', async () => {
    mockChatResponseFormat.mockReturnValue('[00:00] formatted');

    const id = chatManager.submit('vid-166-a', 'Formatter test?');
    await chatManager.process(id);

    // ChatResponseFormatter.format(answer, signalMap) called
    expect(mockChatResponseFormat).toHaveBeenCalled();
    const callArgs = mockChatResponseFormat.mock.calls[0];
    expect(callArgs.length).toBe(2);
    expect(callArgs[1]).toHaveProperty('vid-166-a');
  });

  it('signal without compact_text still works via agent path', async () => {
    toolCallResponses = [
      { name: 'get_compact_text', args: '{"videoIds":["vid-166-b"]}' },
    ];

    const id = chatManager.submit('vid-166-b', 'No compact text?');
    await chatManager.process(id);

    expect(mockCallLlmStreamWithTools).toHaveBeenCalled();
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
    expect(row.answer).not.toBeNull();
  });
});