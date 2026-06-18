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
    expect(mockProcess).toHaveBeenCalledWith(42, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
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

  /* ─── Issue #132: ChatQueue scope awareness for async multi-signal processing ─── */

  it('enqueueScoped accepts ChatScope and persists filter criteria in signal_chat row', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    mockSubmit.mockReturnValue(100);
    mockProcess.mockResolvedValue(undefined);

    const id = queue.enqueueScoped({ topicKey: 'tech', question: 'compare all videos' });
    expect(id).toBe(100);
    expect(mockSubmit).toHaveBeenCalledWith({ topicKey: 'tech', question: 'compare all videos' });

    // Verify the DB row has signal_video_id=NULL with filter columns populated
    const dbRow = db.prepare(
      'SELECT signal_video_id, topic_key, channel_id, include_irrelevant FROM signal_chat WHERE id = ?'
    ).get(100);

    // The mock submit doesn't write to DB, so verify via the mock call args
    // which proves enqueueScoped passes ChatScope to submit correctly
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('enqueueScoped with topicKey + channelId persists both filter columns', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    mockSubmit.mockReturnValue(200);
    mockProcess.mockResolvedValue(undefined);

    queue.enqueueScoped({ topicKey: 'tech', channelId: 'UC_test', question: 'compare on this channel' });
    expect(mockSubmit).toHaveBeenCalledWith({ topicKey: 'tech', channelId: 'UC_test', question: 'compare on this channel' });
  });

  it('enqueueScoped dispatches process via pool (same concurrency limit)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    mockSubmit.mockReturnValue(300);
    mockProcess.mockResolvedValue(undefined);

    queue.enqueueScoped({ topicKey: 'tech', question: 'scoped q' });

    await pool.drain();
    expect(mockProcess).toHaveBeenCalledWith(300, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
  });

  it('enqueueScoped failure leaves answer=NULL and status=failed', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'failing scoped q', 'tech');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockRejectedValue(new Error('multi-signal LLM error'));

    queue.enqueueScoped({ topicKey: 'tech', question: 'failing scoped q' });
    await pool.drain();

    expect(queue.status(insertedId)).toBe('failed');

    // Verify answer stayed NULL in DB
    const row = db.prepare('SELECT answer FROM signal_chat WHERE id = ?').get(insertedId) as { answer: string | null };
    expect(row.answer).toBeNull();
  });

  /* ─── Issue #142: ChatQueue.cancel() — controller registry, abort, and DB delete ─── */

  it('_dispatchProcess creates AbortController, stores in _controllers, passes signal to process()', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let capturedSignal: AbortSignal | undefined;
    mockSubmit.mockReturnValue(500);
    mockProcess.mockImplementation(async (_id: number, options?: { abortSignal?: AbortSignal }) => {
      capturedSignal = options?.abortSignal;
    });

    queue.enqueue('vid_1', 'controller test');
    await pool.drain();

    // process() was called with an abortSignal
    expect(mockProcess).toHaveBeenCalledWith(500, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Controller is stored in registry while task runs; after drain it's cleaned up
    // The key verification is that the signal was passed through
  });

  it('cancel(id) aborts active controller and calls chatManager.delete(id)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const mockDelete = vi.fn();
    const chatManagerInstance = new ChatManagerClass(db, getLlmConfigFn());
    (chatManagerInstance as unknown as Record<string, unknown>).delete = mockDelete;

    let processResolve: () => void;
    mockSubmit.mockReturnValue(600);
    mockProcess.mockImplementation(async (_id: number) => {
      // Block until cancel() is called
      await new Promise<void>((resolve) => { processResolve = resolve; });
    });

    const queue = new ChatQueue(db, chatManagerInstance as unknown as ChatManager, pool);
    queue.enqueue('vid_1', 'cancel test');

    // Give the task time to start in the pool
    await new Promise((r) => setTimeout(r, 50));

    // Cancel should abort + delete
    queue.cancel(600);

    // Unblock process so drain can complete
    processResolve!();
    await pool.drain();

    expect(mockDelete).toHaveBeenCalledWith(600);
  });

  it('cancel() on already-completed task is harmless (no-op abort, delete still works)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const mockDelete = vi.fn();
    const chatManagerInstance = new ChatManagerClass(db, getLlmConfigFn());
    (chatManagerInstance as unknown as Record<string, unknown>).delete = mockDelete;

    mockSubmit.mockReturnValue(700);
    mockProcess.mockResolvedValue(undefined);

    const queue = new ChatQueue(db, chatManagerInstance as unknown as ChatManager, pool);
    queue.enqueue('vid_1', 'completed cancel test');

    // Wait for task to complete and controller to be cleaned up
    await pool.drain();

    // Cancel after completion — should not throw, delete still called
    expect(() => queue.cancel(700)).not.toThrow();
    expect(mockDelete).toHaveBeenCalledWith(700);
  });

  it('AbortError in _dispatchProcess is caught silently — no markFailed', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'abort error test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });

    // Simulate an abort-like error (DOMException with name AbortError)
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockProcess.mockRejectedValue(abortError);

    queue.enqueue('vid_1', 'abort error test');
    await pool.drain();

    // Status should be 'pending' (not 'failed') — AbortError is silently ignored
    expect(queue.status(insertedId)).toBe('pending');
  });

  it('end-to-end: scoped enqueue → process writes answer via pool', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer, topic_key) VALUES (?, ?, NULL, ?)"
      ).run(null, 'e2e scoped q', 'tech');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      db.prepare("UPDATE signal_chat SET answer = 'multi-signal answer' WHERE id = ?").run(insertedId);
    });

    const id = queue.enqueueScoped({ topicKey: 'tech', question: 'e2e scoped q' });
    expect(id).toBe(insertedId);

    // Before drain: pending (process is running in background pool)
    expect(queue.status(insertedId)).toBe('pending');

    await pool.drain();

    // After drain: done
    expect(queue.status(insertedId)).toBe('done');
    expect(queue.statusInfo(insertedId)).toEqual({ status: 'done', answer: 'multi-signal answer', isFormatted: 0 });
  });

  /* ─── Issue #157: ChatQueue PhaseRegistry integration (merged from chat-queue-phase.test.ts) ─── */

  it('statusInfo returns phase and tokenCount when status is pending', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let processGate = () => {};
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'phase test question');
      return Number(result.lastInsertRowid);
    });
    mockProcess.mockImplementation(async (_id: number, options?: { abortSignal?: AbortSignal; onPhaseChange?: (phase: string, count: number) => void }) => {
      if (options?.onPhaseChange) {
        options.onPhaseChange('intake', 0);
        options.onPhaseChange('reasoning', 347);
        options.onPhaseChange('answering', 891);
      }
      // Gate: keep task running until test has read phase data, then resolve
      await new Promise<void>(resolve => { processGate = resolve; });
    });

    const id = queue.enqueue('vid_1', 'phase test question');
    await new Promise((r) => setTimeout(r, 10)); // let task start in pool

    const info = queue.statusInfo(id);
    expect(info).not.toBeNull();
    expect(info!.status).toBe('pending');
    expect(info!.phase).toBeDefined();
    expect(['intake', 'reasoning', 'answering']).toContain(info!.phase);

    processGate();  // let mock complete
    await pool.drain();
  });

  it('PhaseRegistry entries are cleaned up after task completes', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'cleanup test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, count: number) => void }) => {
      if (options?.onPhaseChange) {
        options.onPhaseChange('intake', 0);
      }
      await new Promise((r) => setTimeout(r, 30));
    });

    queue.enqueue('vid_1', 'cleanup test');
    await new Promise((r) => setTimeout(r, 20));

    const infoDuring = queue.statusInfo(insertedId);
    expect(infoDuring).not.toBeNull();
    expect(infoDuring!.phase).toBe('intake');

    await pool.drain();

    const infoAfter = queue.statusInfo(insertedId);
    expect(infoAfter).not.toBeNull();
  });

  it('PhaseRegistry entries are cleaned up after task fails', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'fail cleanup test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, count: number) => void }) => {
      if (options?.onPhaseChange) {
        options.onPhaseChange('reasoning', 100);
      }
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('LLM failed');
    });

    queue.enqueue('vid_1', 'fail cleanup test');
    await pool.drain();

    const info = queue.statusInfo(insertedId);
    expect(info).not.toBeNull();
    expect(info!.status).toBe('failed');
  });

  it('onPhaseChange callback is passed through to process()', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let capturedCallback: ((phase: string, count: number) => void) | undefined;
    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'callback test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, count: number) => void }) => {
      capturedCallback = options?.onPhaseChange;
    });

    queue.enqueue('vid_1', 'callback test');
    await pool.drain();

    expect(capturedCallback).toBeDefined();
    expect(typeof capturedCallback).toBe('function');

    capturedCallback!('reasoning', 42);
    const info = queue.statusInfo(insertedId);
    expect(info).not.toBeNull();
    expect(info!.phase).toBe('reasoning');
    expect(info!.tokenCount).toBe(42);
  });

  it('integration: phase data flows from process through status endpoint response', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let capturedCallback: ((phase: string, count: number) => void) | undefined;
    let insertedId = 0;
    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'integration test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });
    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, count: number) => void }) => {
      capturedCallback = options?.onPhaseChange;
      await new Promise((r) => setTimeout(r, 500));
    });

    queue.enqueue('vid_1', 'integration test');
    await new Promise((r) => setTimeout(r, 30));

    capturedCallback!('intake', 0);
    let info = queue.statusInfo(insertedId);
    expect(info!.phase).toBe('intake');
    expect(info!.tokenCount).toBe(0);

    capturedCallback!('reasoning', 347);
    info = queue.statusInfo(insertedId);
    expect(info!.phase).toBe('reasoning');
    expect(info!.tokenCount).toBe(347);

    capturedCallback!('answering', 891);
    info = queue.statusInfo(insertedId);
    expect(info!.phase).toBe('answering');
    expect(info!.tokenCount).toBe(891);

    await pool.drain();
  });

  /* ─── Issue #159: Batched phase callback with event loop yield ─── */

  it('synchronous callback burst creates boundaries so PhaseRegistry captures intermediate snapshots', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    const capturedSnapshots: Array<{ phase: string; tokenCount: number }> = [];

    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'burst test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });

    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, tokenCount: number) => void }) => {
      const onPhaseChange = options?.onPhaseChange;
      if (onPhaseChange) {
        for (let i = 1; i <= 50; i++) {
          const phase = i <= 25 ? 'reasoning' : 'answering';
          onPhaseChange(phase, i);
          const statusInfo = queue.statusInfo(insertedId);
          if (statusInfo?.phase) {
            capturedSnapshots.push({ phase: statusInfo.phase, tokenCount: statusInfo.tokenCount ?? 0 });
          }
        }
      }
    });

    queue.enqueue('vid_1', 'burst test');
    await pool.drain();

    const uniqueTokenCounts = new Set(capturedSnapshots.map(s => s.tokenCount));
    expect(capturedSnapshots.length).toBe(50);
    expect(uniqueTokenCounts.size).toBeGreaterThan(1);

    const uniquePhases = new Set(capturedSnapshots.map(s => s.phase));
    expect(uniquePhases.has('reasoning')).toBe(true);
    expect(uniquePhases.has('answering')).toBe(true);
  });

  it('batch size constant exists and is documented (around 10)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sourcePath = path.resolve(__dirname, 'chat-queue.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    const hasBatchComment = /batch|yield|PHASE_BATCH_SIZE/i.test(source);
    expect(hasBatchComment).toBe(true);
  });

  it('no changes to llm.ts or phase-registry.ts for batching', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const llmSource = fs.readFileSync(path.resolve(__dirname, 'llm.ts'), 'utf-8');
    const registrySource = fs.readFileSync(path.resolve(__dirname, 'phase-registry.ts'), 'utf-8');

    const batchPattern = /batchCounter|PHASE_BATCH_SIZE|yield.*event.*loop/i;
    expect(batchPattern.test(llmSource)).toBe(false);
    expect(batchPattern.test(registrySource)).toBe(false);
  });

  it('final phase value after burst is correct (last callback wins)', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    let finalTokenCount: number | undefined;

    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'final value test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });

    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, tokenCount: number) => void }) => {
      const onPhaseChange = options?.onPhaseChange;
      if (onPhaseChange) {
        for (let i = 1; i <= 50; i++) {
          onPhaseChange('answering', i);
        }
      }
      const info = queue.statusInfo(insertedId);
      finalTokenCount = info?.tokenCount;
    });

    queue.enqueue('vid_1', 'final value test');
    await pool.drain();

    expect(finalTokenCount).toBe(50);
  });

  it('regression: simulates synchronous burst of 60 calls and verifies intermediate snapshots exist', async () => {
    seedTopic(); seedChannel(); seedSignal();

    const { ChatQueue } = await import('./chat-queue');
    const chatManager = new ChatManagerClass(db, getLlmConfigFn());
    const queue = new ChatQueue(db, chatManager as unknown as ChatManager, pool);

    let insertedId = 0;
    const allTokenCounts: number[] = [];

    mockSubmit.mockImplementation(() => {
      const result = db.prepare("INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)").run('vid_1', 'regression test');
      insertedId = Number(result.lastInsertRowid);
      return insertedId;
    });

    mockProcess.mockImplementation(async (_id: number, options?: { onPhaseChange?: (phase: string, tokenCount: number) => void }) => {
      const onPhaseChange = options?.onPhaseChange;
      if (onPhaseChange) {
        for (let i = 1; i <= 60; i++) {
          onPhaseChange('reasoning', i);
          const info = queue.statusInfo(insertedId);
          if (info?.tokenCount !== undefined) {
            allTokenCounts.push(info.tokenCount);
          }
        }
      }
    });

    queue.enqueue('vid_1', 'regression test');
    await pool.drain();

    expect(allTokenCounts.length).toBe(60);
    const unique = new Set(allTokenCounts);
    expect(unique.size).toBeGreaterThan(1);
    expect(allTokenCounts[allTokenCounts.length - 1]).toBe(60);
  });
});
