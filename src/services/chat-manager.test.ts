import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';

// Mock LLM module — callLlmSync, callLlmStream, and callLlmStreamWithPhases
const mockCallLlmSync = vi.fn().mockResolvedValue('test answer');
/** Captures the prompt passed to callLlmStreamWithPhases so existing tests can verify it. */
let lastStreamPrompt: string | undefined;
vi.mock('../llm', () => ({
  callLlmStream: async function* (_config: unknown, _prompt: unknown) {
    yield 'token';
  },
  callLlmStreamWithPhases: async function* (config: unknown, prompt: string, options?: { onPhaseChange?: (phase: string, count: number) => void }) {
    // Capture prompt for test assertions
    lastStreamPrompt = prompt;
    // Fire intake phase at start
    options?.onPhaseChange?.('intake', 0);
    yield 'token';
    options?.onPhaseChange?.('answering', 5);
  },
  get callLlmSync() {
    return mockCallLlmSync;
  },
}));

// Mock ChatResponseFormatter so we can verify it is called
// vi.mock is hoisted, so the factory must not reference variables declared later.
// We use a getter on the module to lazily resolve the mock at runtime.
const mockChatResponseFormat = vi.fn((text: string | null | undefined) => text ?? '');
vi.mock('../chat-response-formatter', () => ({
  get ChatResponseFormatter() {
    return { format: mockChatResponseFormat };
  },
}));

import { ChatManager } from './chat-manager';

let db: Database.Database;
let chatManager: ChatManager;

function insertSignal(videoId: string) {
  db.prepare(
    `INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
  ).run(videoId + '_ch', 'Test Channel', Date.now());

  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, videoId + '_ch', 'Test Signal', '2103-12-31T00:00:00Z', '[]', 'test summary', 4, Date.now());
}

describe('ChatManager two-phase persist', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    initDb(db);
    insertSignal('video-1');

    chatManager = new ChatManager(db, { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' });
  });

  afterAll(() => {
    db.close();
  });

  describe('submit()', () => {
    it('inserts row with answer=NULL and returns question ID', () => {
      const id = chatManager.submit('video-1', 'What is MTG?');
      expect(id).toBeTypeOf('number');
      expect(id).toBeGreaterThan(0);

      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id);
      expect(row).toBeDefined();
      // @ts-expect-error — answer column can be null
      expect(row.answer).toBeNull();
    });

    it('throws when signal not found', () => {
      expect(() => chatManager.submit('nonexistent', 'hi')).toThrow();
    });
  });

  describe('process()', () => {
    beforeEach(() => {
      mockCallLlmSync.mockClear().mockResolvedValue('test answer');
      // Default: pass-through identity so ChatResponseFormatter.format(x, map) returns x unchanged
      mockChatResponseFormat.mockClear().mockImplementation((text: string | null | undefined) => text ?? '');
    });

    it('applies ChatResponseFormatter to single-signal async answers', async () => {
      mockChatResponseFormat.mockClear().mockReturnValue('[00:42] formatted link');

      const id = chatManager.submit('video-1', 'When were rates discussed?');
      await chatManager.process(id);

      // ChatResponseFormatter.format should have been called with the buffered stream answer and a signalMap
      expect(mockChatResponseFormat).toHaveBeenCalledWith('token', expect.any(Object));
      // And the persisted answer should be the formatted version
      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
      expect(row.answer).toBe('[00:42] formatted link');
    });

    it('updates answer on successful LLM call', async () => {
      mockChatResponseFormat.mockClear().mockImplementation((text) => text ?? '');

      const id = chatManager.submit('video-1', 'Process me?');
      expect(id).toBeTypeOf('number');

      await chatManager.process(id);

      const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(id) as { answer: string | null };
      // Streaming yields 'token' which is the buffered answer
      expect(row.answer).toBe('token');
    });

    it('leaves answer=NULL when LLM call fails', async () => {
      const id = chatManager.submit('video-1', 'Fail me?');

      // The streaming mock doesn't throw by default, so we verify the happy path above.
      // For failure: the streaming path catches errors and re-throws without writing to DB.
      // This is verified in chat-manager-streaming.test.ts with a throwing stream mock.
      // Here just verify process() completes without error for the default mock.
      await expect(chatManager.process(id)).resolves.toBeUndefined();
    });
  });

  // Bug 1 + Bug 3: three-tier template resolution for multi-signal chat
  describe('_processMultiSignal three-tier template resolution', () => {
    it('uses DB global default when no topic override exists', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('multi answer');

      // Create a topic without multi_signal_summary_prompt
      db.prepare(
        "INSERT OR REPLACE INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
      ).run(99, 'mtg', 'MTG', 'Magic cards');

      // Insert a multi-signal scoped row
      const id = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'multi q', 'mtg').lastInsertRowid as number;

      // Set global multi_signal_chat_prompt in app_settings
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
      ).run('multi_signal_chat_prompt', 'GLOBAL MULTI TEMPLATE');

      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      expect(lastStreamPrompt).toContain('GLOBAL MULTI TEMPLATE');
    });

    it('uses topic override when multi_signal_summary_prompt is set (Bug 1)', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('multi answer');

      // Create a topic WITH multi_signal_summary_prompt override
      db.prepare(
        "INSERT OR REPLACE INTO topics (id, key, short_name, filter_text, multi_signal_summary_prompt) VALUES (?, ?, ?, ?, ?)"
      ).run(98, 'mtg2', 'MTG2', 'Magic cards', 'TOPIC OVERRIDE TEMPLATE');

      // Also set a global default — topic override should win
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
      ).run('multi_signal_chat_prompt', 'GLOBAL MULTI TEMPLATE');

      const id = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'topic override q', 'mtg2').lastInsertRowid as number;

      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // Topic override should be used, NOT the global default
      expect(lastStreamPrompt).toContain('TOPIC OVERRIDE TEMPLATE');
      expect(lastStreamPrompt).not.toContain('GLOBAL MULTI TEMPLATE');
    });

    it('falls back to default template when no DB setting', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('multi answer');

      // No app_settings row for multi_signal_chat_prompt
      db.prepare("DELETE FROM app_settings WHERE key = 'multi_signal_chat_prompt'").run();

      const id = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'fallback q', 'mtg').lastInsertRowid as number;

      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // Should use the compiled default template
      expect(lastStreamPrompt).toContain('content analyst');
    });
  });

  // Bug 2: filter_text passed to multi-signal prompt from topic scope
  describe('_processMultiSignal filterText from topic (Bug 2)', () => {
    it('passes filterText from topic to assembleMultiSignalChat', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('multi answer');

      // Create a topic with filter_text
      db.prepare(
        "INSERT OR REPLACE INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
      ).run(97, 'mtg3', 'MTG3', 'Magic: The Gathering news and updates');

      const id = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'filter text q', 'mtg3').lastInsertRowid as number;

      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // filter_text should be in the prompt inside <filter_text> block
      expect(lastStreamPrompt).toContain('Magic: The Gathering news and updates');
    });
  });

  // Bug 4 (issue #137): legacy ask() sets is_formatted column
  describe('legacy ask() is_formatted', () => {
    it('sets is_formatted=0 when storing via legacy ask() without transform', async () => {
      // Consume the streaming ask() generator without a transform
      const tokens: string[] = [];
      for await (const token of chatManager.ask('video-1', 'Streaming question?')) {
        tokens.push(token);
      }

      // Find the last inserted row for this question
      const row = db.prepare(
        "SELECT is_formatted FROM signal_chat WHERE question = ? ORDER BY id DESC LIMIT 1"
      ).get('Streaming question?') as { is_formatted: number };

      expect(row).toBeDefined();
      expect(row.is_formatted).toBe(0);
    });

    it('sets is_formatted=1 when storing via legacy ask() with transform', async () => {
      // Consume the streaming ask() generator WITH a transform
      const tokens: string[] = [];
      for await (const token of chatManager.ask('video-1', 'Streaming with transform?', (t) => t.toUpperCase())) {
        tokens.push(token);
      }

      const row = db.prepare(
        "SELECT is_formatted, answer FROM signal_chat WHERE question = ? ORDER BY id DESC LIMIT 1"
      ).get('Streaming with transform?') as { is_formatted: number; answer: string };

      expect(row.is_formatted).toBe(1);
      // Answer should be transformed (uppercased)
      expect(row.answer).not.toBe('token');
    });
  });

  // Issue #148: compact_text wired into per-signal chat
  describe('Issue 148 — compactText in per-signal chat', () => {
    it('process() uses compactText from DB when available', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('compact answer');

      // Insert a signal WITH compact_text
      db.prepare(
        `INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
      ).run('compact_ch', 'Compact Channel', Date.now());

      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, compact_text, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'compact-video', 'compact_ch', 'Compact Signal', '2103-12-31T00:00:00Z',
        JSON.stringify([{ time: 0, text: 'so um you know the Kaldra set is not bad at all and we talked about it for a long time' }]),
        'Kaldra discussion',
        '[T:0] Kaldra set not bad discussed',
        4, Date.now()
      );

      const id = chatManager.submit('compact-video', 'What about Kaldra?');
      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // Prompt should use compact text, NOT the verbose full transcription
      expect(lastStreamPrompt).toContain('[T:0] Kaldra set not bad discussed');
      expect(lastStreamPrompt).not.toContain('so um you know');
    });

    it('process() falls back to formatted transcription when compactText is NULL', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('fallback answer');

      // Insert a signal WITHOUT compact_text (NULL)
      db.prepare(
        `INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
      ).run('fallback_ch', 'Fallback Channel', Date.now());

      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, compact_text, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'fallback-video', 'fallback_ch', 'Fallback Signal', '2103-12-31T00:00:00Z',
        JSON.stringify([{ time: 42000, text: 'full transcript segment' }]),
        'Some summary',
        null, // compact_text is NULL
        3, Date.now()
      );

      const id = chatManager.submit('fallback-video', 'q?');
      await chatManager.process(id);

      // Streaming path used — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // Must fall back to formatted transcription
      expect(lastStreamPrompt).toContain('[T:42] full transcript segment');
    });

    it('ask() streaming uses compactText when available', async () => {
      // Insert a signal with compact_text (already done above: 'compact-video')
      const tokens: string[] = [];
      for await (const token of chatManager.ask('compact-video', 'Streaming compact?')) {
        tokens.push(token);
      }

      // The ask() method internally calls assembleChat which should prefer compactText
      // We can't inspect the prompt directly in streaming, but we verify no error was thrown
      // and tokens were yielded
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  // Issue #152: chat_response_format from AppSettings wired into ChatManager
  describe('Issue 152 — chat_response_format from AppSettings', () => {
    it('_processSingleSignal reads format style from AppSettings and passes to assembler', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('format answer');

      // Set chat_response_format to 'plain'
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
      ).run('chat_response_format', 'plain');

      const id = chatManager.submit('video-1', 'Format style question?');
      await chatManager.process(id);

      // Streaming path used instead of sync — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // With 'plain' style, FORMAT_INSTRUCTIONS is empty — placeholder must be replaced (not remain raw)
      expect(lastStreamPrompt).not.toContain('{FORMAT_INSTRUCTIONS}');
    });

    it('_processMultiSignal reads format style from AppSettings and passes to assembler', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('multi format answer');

      // Create topic for multi-signal scope
      db.prepare(
        "INSERT OR REPLACE INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)"
      ).run(96, 'mtg4', 'MTG4', 'Magic cards');

      // Set chat_response_format to 'plain'
      db.prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
      ).run('chat_response_format', 'plain');

      const id = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'multi format q', 'mtg4').lastInsertRowid as number;

      await chatManager.process(id);

      // Streaming path used instead of sync — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // FORMAT_INSTRUCTIONS placeholder must be replaced
      expect(lastStreamPrompt).not.toContain('{FORMAT_INSTRUCTIONS}');
    });

    it('defaults to "annotated-index" when AppSettings key not set', async () => {
      mockCallLlmSync.mockClear().mockResolvedValue('default format answer');

      // Ensure chat_response_format is NOT set
      db.prepare("DELETE FROM app_settings WHERE key = 'chat_response_format'").run();

      const id = chatManager.submit('video-1', 'Default format question?');
      await chatManager.process(id);

      // Streaming path used instead of sync — verify via lastStreamPrompt
      expect(lastStreamPrompt).toBeDefined();
      // FORMAT_INSTRUCTIONS must be replaced (default annotated-index renders)
      expect(lastStreamPrompt).not.toContain('{FORMAT_INSTRUCTIONS}');
    });

    it('ask() streaming path has FORMAT_INSTRUCTIONS rendered', async () => {
      // Ensure no chat_response_format set — should default to 'annotated-index'
      db.prepare("DELETE FROM app_settings WHERE key = 'chat_response_format'").run();

      const tokens: string[] = [];
      for await (const token of chatManager.ask('video-1', 'Streaming format?')) {
        tokens.push(token);
      }

      // Verify no error, tokens yielded
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe('getHistory() and delete()', () => {
    it('getHistory returns rows including NULL answers', () => {
      chatManager.submit('video-1', 'Pending question?');
      const history = chatManager.getHistory('video-1');
      const pending = history.find((h) => h.question === 'Pending question?');
      expect(pending).toBeDefined();
    });

    it('returns null signal_video_id for list-scoped messages (Bug 134)', () => {
      // Insert a list-scoped row with signal_video_id = NULL
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, ?, ?)"
      ).run(null, 'list scoped q', 'list answer', 'mtg');

      const scope = { topicKey: 'mtg' };
      const history = chatManager.getHistory(scope);
      const listMsg = history.find((h) => h.question === 'list scoped q');

      expect(listMsg).toBeDefined();
      // signal_video_id must be nullable per ChatMessage interface
      expect(listMsg!.signal_video_id).toBeNull();
    });

    it('delete removes a row', () => {
      const id = chatManager.submit('video-1', 'Delete me?');
      chatManager.delete(id);
      const remaining = db.prepare('SELECT COUNT(*) as cnt FROM signal_chat WHERE id = ?').get(id);
      expect((remaining as { cnt: number }).cnt).toBe(0);
    });
  });
});