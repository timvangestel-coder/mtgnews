import Database from 'better-sqlite3';
import { listActiveChannels } from './db/watchlist';
import { pollChannel, PollOptions } from './poll';
import { analyzeSignal, getLlmConfig } from './llm';
import { preRegisterChannelProgress, getPollRunById, queryPollRunProgress, PollRunRow, PollRunProgressRow } from './db/poll-runs';

/** Unique identifier for a poll run */
export type RunId = number;

/** Step-level progress for one channel */
export interface PollRunStep {
  displayName: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  total: number;     // signals discovered for this channel
  done: number;      // signals processed (relevant + irrelevant + failed)
}

/** View model representing the full state of a poll run */
export interface RunState {
  id: RunId;
  status: 'running' | 'complete' | 'failed' | 'aborted';
  steps: PollRunStep[];
}

/** Legacy-compatible progress result */
export interface CurrentProgressResult {
  run: PollRunRow;
  progress: PollRunProgressRow[];
}

/** In-memory registry of active runs */
interface ActiveRunEntry {
  controller: AbortController;
  worker: Promise<void>;
}

/**
 * ConcurrencyPool — limits parallel task execution with a drain() method.
 * Tasks are dispatched via run() and drain() waits for all to complete.
 */
class ConcurrencyPool {
  private running = new Set<Promise<void>>();
  private concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  /** Dispatch a task to the pool. Returns immediately. */
  run(fn: () => Promise<void>): void {
    const p = (async () => {
      try {
        await fn();
      } finally {
        this.running.delete(p);
      }
    })();
    this.running.add(p);

    // If we're at concurrency limit, wait for one to finish before returning
    if (this.running.size >= this.concurrency) {
      Promise.race(this.running).catch(() => {});
    }
  }

  /** Wait for all dispatched tasks to complete. */
  async drain(): Promise<void> {
    await Promise.all(Array.from(this.running));
  }
}

/**
 * PollRunManager — deep module that owns the full poll run lifecycle.
 *
 * Consolidates:
 * - poll-scheduler.ts (enqueue, register/unregister)
 * - poll-worker.ts (execute Phase 1 + Phase 2)
 * - PollTriggerService (trigger, abort, query progress)
 *
 * Clean interface: startRun(), abortRun(), runState()
 */
export class PollRunManager {
  private activeRuns = new Map<RunId, ActiveRunEntry>();

  constructor(private db: Database.Database) {}

  /** Expose the database instance for external worker spawning (compatibility). */
  get database(): Database.Database {
    return this.db;
  }

  // ── Public Interface ──────────────────────────────────────────────

  /** Start a new poll run. Enqueues, pre-registers channels, spawns worker. Returns the runId. */
  async startRun(lookbackDays: number = 2): Promise<RunId> {
    const runId = this.enqueuePollRun(lookbackDays);

    // Pre-register pending progress rows so the UI shows channels immediately
    preRegisterChannelProgress(this.db, runId);

    // Spawn worker in background (non-blocking)
    const controller = new AbortController();
    const worker = this.workerProcessRun(runId, { signal: controller.signal }).catch(console.error);
    this.activeRuns.set(runId, { controller, worker });

    return runId;
  }

  /** Abort an active poll run. Throws if run not found or already aborted. */
  async abortRun(runId: RunId): Promise<void> {
    this.abortPollRun(runId);
  }

  /** Get the RunState view model for a specific run, or null if not found. */
  runState(runId: RunId): RunState | null {
    const run = getPollRunById(this.db, runId);
    if (!run) return null;

    const progress = queryPollRunProgress(this.db, runId);
    const steps: PollRunStep[] = progress.map((p) => ({
      displayName: p.display_name,
      status: this.mapStepStatus(p.status),
      total: p.signals_found,
      done: p.signalsDone,
    }));

    return {
      id: run.id,
      status: this.mapStatus(run.status),
      steps,
    };
  }

  /** Get the latest poll run and its progress rows, or null if no runs exist. */
  currentProgress(): CurrentProgressResult | null {
    const row = this.db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null } | undefined;
    const maxId = row?.max_id;
    if (!maxId) return null;

    const run = getPollRunById(this.db, maxId);
    if (!run) return null;

    const progress = queryPollRunProgress(this.db, run.id);
    return { run, progress };
  }

  // ── Internal: Enqueue (from poll-scheduler.ts) ────────────────────

  private enqueuePollRun(lookbackDays: number = 2): RunId {
    const stmt = this.db.prepare(
      'INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)'
    );
    const result = stmt.run(Date.now(), 'running', lookbackDays);
    return Number(result.lastInsertRowid);
  }

  // ── Internal: Worker (from poll-worker.ts) ────────────────────────

  private async workerProcessRun(runId: RunId, options?: { signal?: AbortSignal }): Promise<void> {
    const signal = options?.signal;

    // read lookback_days from poll_runs row
    const runRow = this.db.prepare(
      'SELECT lookback_days FROM poll_runs WHERE id = ?'
    ).get(runId) as { lookback_days: number | null } | undefined;
    const lookbackDays = runRow?.lookback_days ?? 2;

    // Read concurrency limit from env
    const concurrency = parseInt(process.env.LLM_CONCURRENCY || '3', 10);

    // Log warnings for active channels with NULL topic_id
    const skippedChannels = this.db.prepare(
      "SELECT channel_id, display_name FROM channels WHERE active = 1 AND topic_id IS NULL"
    ).all() as Array<{ channel_id: string; display_name: string | null }>;

    for (const ch of skippedChannels) {
      console.warn(`Skipping channel ${ch.channel_id} (${ch.display_name ?? 'unknown'}): NULL topic_id`);
    }

    const channels = listActiveChannels(this.db);
    let totalNewSignals = 0;

    const llmConfig = getLlmConfig();

    // Global concurrency pool for analysis tasks — shared across all channels
    const pool = new ConcurrencyPool(concurrency);

    // Helper: upsert a progress row
    const upsertProgress = (channelId: string, status: string, signalsFound: number) => {
      const updated = this.db.prepare(
        'UPDATE poll_run_progress SET status = ?, signals_found = ?, updated_at = ? WHERE poll_run_id = ? AND channel_id = ?'
      ).run(status, signalsFound, Date.now(), runId, channelId);
      if ((updated as any).changes === 0) {
        this.db.prepare(
          'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(runId, channelId, status, signalsFound, Date.now());
      }
    };

    // Helper: increment done counter for a channel, transition to 'done' when all signals processed
    const incrementDone = (channelId: string) => {
      this.db.transaction(() => {
        this.db.prepare(
          'UPDATE poll_run_progress SET signals_done = signals_done + 1, updated_at = ? WHERE poll_run_id = ? AND channel_id = ?'
        ).run(Date.now(), runId, channelId);

        // Transition to 'done' when all signals for this channel are processed
        const row = this.db.prepare(
          'SELECT signals_found, signals_done FROM poll_run_progress WHERE poll_run_id = ? AND channel_id = ?'
        ).get(runId, channelId) as { signals_found: number; signals_done: number } | undefined;

        if (row && row.signals_done >= row.signals_found && row.signals_found > 0) {
          this.db.prepare(
            "UPDATE poll_run_progress SET status = 'done', updated_at = ? WHERE poll_run_id = ? AND channel_id = ?"
          ).run(Date.now(), runId, channelId);
        }
      })();
    };

    // Streaming pipeline: poll each channel, then immediately dispatch analysis tasks
    for (const channel of channels) {
      if (signal?.aborted) {
        console.log(`Worker aborted during channel polling at ${channel.channel_id}`);
        break;
      }

      try {
        // Poll and discover signals — no DB write during polling
        const result = await pollChannel(this.db, channel.channel_id, {
          lookbackDays,
          runId,
        } as PollOptions);

        totalNewSignals += result.newSignals;

        if (result.newSignals > 0) {
          // Write progress only after signals discovered
          upsertProgress(channel.channel_id, 'processing', result.newSignals);

          const newSignals = this.db.prepare(
            'SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processed_at IS NULL'
          ).all(channel.channel_id, runId) as { video_id: string }[];

          // Dispatch analysis tasks immediately to global pool
          for (const s of newSignals) {
            pool.run(async () => {
              try {
                await analyzeSignal(this.db, s.video_id, llmConfig, signal);
              } catch (err) {
                const msg = (err as Error).message;
                if (msg.includes('AbortError') || msg.includes('aborted')) {
                  // Still increment done on abort-related errors
                  incrementDone(channel.channel_id);
                  return;
                }
                console.error(`analyzeSignal failed for ${s.video_id}: ${msg}`);
              }

              // Always increment done counter, even on failure
              incrementDone(channel.channel_id);
            });
          }
        } else {
          // No signals found — mark as done with total=0
          upsertProgress(channel.channel_id, 'done', 0);
        }
      } catch (err) {
        upsertProgress(channel.channel_id, 'failed', 0);
      }
    }

    // Wait for all in-flight analysis tasks to complete
    await pool.drain();

    // Check if aborted before marking done
    if (signal?.aborted) {
      console.log(`Worker runId=${runId} stopped due to abort`);
      this.activeRuns.delete(runId);
      return;
    }

    // Mark run as complete
    this.db.prepare(
      'UPDATE poll_runs SET status = ?, new_signal_count = ?, completed_at = ? WHERE id = ?'
    ).run('done', totalNewSignals, Date.now(), runId);

    this.activeRuns.delete(runId);
  }

  // ── Internal: Abort (from abort.ts) ───────────────────────────────

  private abortPollRun(runId: RunId): void {
    // Step 1: cancel in-flight work via AbortController
    const active = this.activeRuns.get(runId);
    if (active) {
      console.log(`ABORT runId=${runId}: firing AbortController to cancel worker`);
      active.controller.abort('Poll run aborted by user');
    }

    // Fetch current run
    const run = this.db.prepare(`
      SELECT id, triggered_at, status FROM poll_runs WHERE id = ?
    `).get(runId) as { id: number; triggered_at: number; status: string } | undefined;

    if (!run) {
      throw new Error(`PollRun #${runId} not found`);
    }

    if (run.status === 'done-forced') {
      throw new Error(`PollRun #${runId} already aborted (done-forced)`);
    }

    const abortTime = Date.now();

    // Use explicit transaction for atomicity
    const txn = this.db.transaction((rid: number, at: number) => {
      // Delete entity_mentions for unsummarized signals in this run
      this.db.prepare(`
        DELETE FROM entity_mentions WHERE signal_video_id IN (
          SELECT video_id FROM signals
          WHERE poll_run_id = ? AND processed_at IS NULL
        )
      `).run(rid);

      // Delete unsummarized signals by FK
      this.db.prepare(`
        DELETE FROM signals
        WHERE poll_run_id = ? AND processed_at IS NULL
      `).run(rid);

      // Count remaining processed signals from this run
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM signals
        WHERE poll_run_id = ? AND processed_at IS NOT NULL
      `).get(rid) as { cnt: number };

      // Always keep the run row so the UI can display "done-forced" status
      this.db.prepare(`
        UPDATE poll_runs SET status = 'done-forced', new_signal_count = ?, abort_time = ? WHERE id = ?
      `).run(row.cnt, at, rid);
    });

    txn(runId, abortTime);
  }

  // ── Internal: Status mapping ───────────────────────────────────────

  private mapStatus(dbStatus: string): RunState['status'] {
    switch (dbStatus) {
      case 'running': return 'running';
      case 'done': return 'complete';
      case 'done-forced': return 'aborted';
      case 'failed': return 'failed';
      default: return 'failed';
    }
  }

  private mapStepStatus(dbStatus: string): PollRunStep['status'] {
    switch (dbStatus) {
      case 'pending': return 'pending';
      case 'running': return 'processing';
      case 'processing': return 'processing';
      case 'done': return 'done';
      case 'failed': return 'failed';
      default: return 'done';
    }
  }
}