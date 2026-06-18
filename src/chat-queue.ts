import Database from 'better-sqlite3';
import { ConcurrencyPool } from './concurrency-pool.ts';
import { ChatManager } from './services/chat-manager.ts';
import { ChatScope } from './signal-chat-scope.ts';
import { PhaseRegistry, type LlmPhase } from './phase-registry.ts';

/**
 * ChatQueue — manages chat question processing through the global ConcurrencyPool.
 *
 * Decouples HTTP request lifecycle from LLM processing:
 * - enqueue() returns immediately after submit()
 * - process() tasks dispatch in background via shared pool
 */
export class ChatQueue {
  /** Registry of AbortControllers for in-flight tasks, keyed by question id. */
  private _controllers = new Map<number, AbortController>();

  /** Registry of LLM phase progress, keyed by question id. */
  private _phaseRegistry = new PhaseRegistry<number>();

  /** Yield to the event loop every N phase-change callbacks so external observers (e.g. HTTP polling) can capture intermediate PhaseRegistry snapshots during synchronous callback bursts. */
  private static readonly PHASE_BATCH_SIZE = 10;

  constructor(
    private db: Database.Database,
    private chatManager: ChatManager,
    private pool: ConcurrencyPool
  ) {}

  /**
   * Enqueue a chat question for async processing.
   * Returns the question ID immediately after inserting a pending row.
   */
  enqueue(signalVideoId: string, question: string): number {
    const id = this.chatManager.submit(signalVideoId, question);

    // Dispatch processing task to shared pool
    this._dispatchProcess(id);

    return id;
  }

  /**
   * Enqueue a list-scoped chat question for async processing.
   * Returns the question ID immediately after inserting a pending row.
   */
  enqueueScoped(scope: ChatScope): number {
    const id = this.chatManager.submit(scope);

    // Dispatch processing task to shared pool
    this._dispatchProcess(id);

    return id;
  }

  /**
   * Internal: dispatch a process task to the shared concurrency pool.
   * Creates an AbortController, stores it in _controllers, and passes the signal to process().
   */
  _dispatchProcess(id: number): void {
    const controller = new AbortController();
    this._controllers.set(id, controller);

    this.pool.run(async () => {
      let batchCounter = 0;

      try {
        await this.chatManager.process(id, {
          abortSignal: controller.signal,
          onPhaseChange: (phase: LlmPhase, tokenCount: number) => {
            batchCounter++;
            // Update registry synchronously so value is immediately observable
            this._phaseRegistry.set(id, phase, tokenCount);
            // Schedule a macrotask yield every PHASE_BATCH_SIZE calls so external observers can see intermediate values during synchronous bursts
            if (batchCounter % ChatQueue.PHASE_BATCH_SIZE === 0) {
              setTimeout(() => {}, 0);
            }
          },
        });
      } catch (err) {
        // Silently ignore AbortError — aborted tasks are not marked as failed
        const message = (err as Error).message ?? '';
        const name = (err as Error).name ?? '';
        if (name === 'AbortError' || message.includes('AbortError') || message.includes('aborted')) {
          return;
        }
        // Process failure leaves answer=NULL → mark as failed
        this.markFailed(id);
      } finally {
        // Cleanup: remove controller and phase data when task settles
        this._controllers.delete(id);
        this._phaseRegistry.delete(id);
      }
    });
  }

  /**
   * Cancel a chat question: abort in-flight LLM work and delete the DB row.
   * Harmless no-op for already-completed tasks (abort on absent controller is skipped, delete still runs).
   */
  cancel(id: number): void {
    // Fire abort if controller exists
    const controller = this._controllers.get(id);
    if (controller) {
      controller.abort('Chat question cancelled');
    }

    // Delete the DB row immediately
    this.chatManager.delete(id);
  }

  /**
   * Rich status info for HTMX polling responses.
   * Returns status + answer text when done, so the UI can swap in the result.
   */
  statusInfo(id: number): { status: 'pending' | 'done' | 'failed'; answer?: string; isFormatted?: number; phase?: LlmPhase; tokenCount?: number } | null {
    const row = this.db.prepare(
      'SELECT answer, COALESCE(is_formatted, 0) AS is_formatted FROM signal_chat WHERE id = ?'
    ).get(id) as { answer: string | null; is_formatted: number } | undefined;

    if (!row) return null;

    if (this._failedIds.has(id)) return { status: 'failed' };
    if (row.answer !== null && row.answer !== undefined) return { status: 'done', answer: row.answer, isFormatted: row.is_formatted };

    // Include phase data from registry when pending
    const phaseEntry = this._phaseRegistry.get(id);
    return {
      status: 'pending',
      phase: phaseEntry?.phase,
      tokenCount: phaseEntry?.tokenCount,
    };
  }

  /**
   * Returns the current processing status of a chat question.
   * - 'pending': row exists but answer is still NULL and not yet failed
   * - 'done': answer has been written
   * - 'failed': processing error occurred, answer remains NULL
   * - null: question id not found
   */
  status(id: number): 'pending' | 'done' | 'failed' | null {
    const info = this.statusInfo(id);
    return info?.status ?? null;
  }

  private _failedIds = new Set<number>();

  /** Mark a question ID as failed (called internally). */
  private markFailed(id: number): void {
    this._failedIds.add(id);
  }
}