import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatManager } from './services/chat-manager';
import { ConcurrencyPool } from './concurrency-pool';
import { createTestDb } from '../tests/fixtures/test-db';

// Mock ChatManager so we can spy on its methods
const mockSubmit = vi.fn();
const mockProcess = vi.fn();

vi.mock('./services/chat-manager', () => ({
  ChatManager: vi.fn().mockImplementation(() => ({
    submit: (...args: unknown[]) => mockSubmit(...args),
    process: (...args: unknown[]) => mockProcess(...args),
  })),
}));

// Mock callLlmSync so tests don't hit real LLM
vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    callLlmSync: vi.fn().mockResolvedValue('test answer'),
    getLlmConfig: actual.getLlmConfig,
  };
});

// Dynamic imports after mocks are hoisted
let ChatManagerClass: typeof ChatManager;
let getLlmConfigFn: () => import('./llm').LlmConfig;

describe('ChatQueue', () => {
  let db: Database.Database;
  let pool: ConcurrencyPool;

  beforeAll(async () => {
    const cm = await import('./services/chat-manager');
    ChatManagerClass = cm.ChatManager;
    const llm = await import('./llm');
    getLlmConfigFn = llm.getLlmConfig;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    pool = new ConcurrencyPool(2);
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

  it('enqueue inserts pending row and dispatches processing via pool', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    mockSubmit.mockReturnValue(42);
    mockProcess.mockResolvedValue(undefined);

    const id = queue.enqueue('vid_1', 'what is this about?');
    expect(id).toBe(42);
    expect(mockSubmit).toHaveBeenCalledWith('vid_1', 'what is this about?');

    await pool.drain();
    expect(mockProcess).toHaveBeenCalledWith(42);
  });

  it('multiple enqueue calls are all processed through shared pool', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let submitCounter = 1;
    mockSubmit.mockImplementation(() => submitCounter++);
    mockProcess.mockResolvedValue(undefined);

    const id1 = queue.enqueue('vid_1', 'question one');
    const id2 = queue.enqueue('vid_1', 'question two');
    const id3 = queue.enqueue('vid_1', 'question three');

    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);

    await pool.drain();
    expect(mockProcess).toHaveBeenCalledTimes(3);
  });

  it('drain waits for all queued chat tasks to complete', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let submitCounter = 1;
    mockSubmit.mockImplementation(() => submitCounter++);

    mockProcess.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    queue.enqueue('vid_1', 'slow question 1');
    queue.enqueue('vid_1', 'slow question 2');

    await pool.drain();
  });

  it('status returns pending for a row with answer NULL', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'status question');
    const rowId = Number(result.lastInsertRowid);

    const status = queue.status(rowId);
    expect(status).toBe('pending');
  });

  it('status returns done after process writes answer', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'status question');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async () => {
      db.prepare("UPDATE signal_chat SET answer = 'done answer' WHERE id = ?").run(insertedId);
    });

    queue.enqueue('vid_1', 'status question');
    await pool.drain();

    const status = queue.status(insertedId);
    expect(status).toBe('done');
  });

  it('status returns failed when process throws and answer stays NULL', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'failing question');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockRejectedValue(new Error('LLM error'));

    queue.enqueue('vid_1', 'failing question');
    await pool.drain();

    const status = queue.status(insertedId);
    expect(status).toBe('failed');
  });

  it('status returns null for non-existent id', async () => {
    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    expect(queue.status(99999)).toBeNull();
  });
});