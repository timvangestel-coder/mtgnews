import Database from 'better-sqlite3';
import { listActiveChannels } from './db/watchlist.ts';
import { pollChannel, PollOptions } from './poll.ts';
import { analyzeSignal, getLlmConfig } from './llm.ts';
import { preRegisterChannelProgress, getPollRunById, queryPollRunProgress, PollRunRow, PollRunProgressRow } from './db/poll-runs.ts';
import { deletePendingForRun, countProcessedForRun, pendingSignalsForChannel } from './signal-state.ts';
import { ConcurrencyPool } from './concurrency-pool.ts';
import { mapStatus, mapStepStatus, type RunState, type PollRunStep } from './utils/poll-run-view-model.ts';
import { PhaseRegistry, type LlmPhase, type PhaseEntry } from './phase-registry.ts';
import { DEFAULT_REQUEST_DELAY_MS } from './rss-feed-fetcher.ts';

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unique identifier for a poll run */
export type RunId = number;

// Re-export view model types for consumers of this module
export { RunState, PollRunStep } from './utils/poll-run-view-model.ts';

/** @internal Legacy-compatible progress result — kept for internal test use only. Use {@link PollProgress} instead. */
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
 * PollRunManager — deep module that owns the full poll run lifecycle.
 *
 * Consolidates:
 * - poll-scheduler.ts (enqueue, register/unregister)
 * - poll-worker.ts (execute Phase 1 + Phase 2)
 * - PollTriggerService (trigger, abort, query progress)
 *
 * Clean interface: startRun(), abortRun(), runState()
 */
/** Per-signal phase data returned in progress */
export interface SignalPhaseInfo {
  videoId: string;
  /** Human-readable label: "Channel Name — YouTube Title" or fallback to videoId */
  displayLabel: string;
  phase: LlmPhase;
  tokenCount: number;
}

/** Composed progress view model replacing the leaky three-call interface */
export interface PollProgress {
  state: RunState;
  signalPhases: SignalPhaseInfo[];
}

export class PollRunManager {
  private activeRuns = new Map<RunId, ActiveRunEntry>();
  /** Phase registry keyed by videoId for the current run */
  private _phaseRegistry = new PhaseRegistry<string>();
  /** Display labels keyed by videoId: "Channel Name — YouTube Title" */
  private _displayLabels = new Map<string, string>();

  constructor(
    private db: Database.Database,
    private pool?: ConcurrencyPool
  ) {}

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
      status: mapStepStatus(p.status),
      total: p.signals_found,
      done: p.signalsDone,
    }));

    return {
      id: run.id,
      status: mapStatus(run.status),
      steps,
    };
  }

  /** @internal Get the latest poll run and its raw progress rows. Use {@link progress()} instead. */
  currentProgress(): CurrentProgressResult | null {
    const row = this.db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null } | undefined;
    const maxId = row?.max_id;
    if (!maxId) return null;

    const run = getPollRunById(this.db, maxId);
    if (!run) return null;

    const progress = queryPollRunProgress(this.db, run.id);
    return { run, progress };
  }

  /** Get per-signal phase data from the registry for active signals */
  getSignalPhases(): SignalPhaseInfo[] {
    const result: SignalPhaseInfo[] = [];
    for (const [videoId, entry] of this._phaseRegistry.getAll()) {
      result.push({
        videoId,
        displayLabel: this._displayLabels.get(videoId) ?? videoId,
        phase: entry.phase,
        tokenCount: entry.tokenCount,
      });
    }
    return result;
  }

  /** Expose registry for internal testing */
  _getPhaseRegistry(): PhaseRegistry<string> {
    return this._phaseRegistry;
  }

  /** Get composed progress view model for the latest run, or null if no runs exist. */
  progress(): PollProgress | null {
    const row = this.db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null } | undefined;
    const maxId = row?.max_id;
    if (!maxId) return null;

    const state = this.runState(maxId);
    if (!state) return null;

    return {
      state,
      signalPhases: this.getSignalPhases(),
    };
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

    // Use external pool if provided, otherwise create internal one
    const taskPool = this.pool ?? new ConcurrencyPool(concurrency);

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
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      if (signal?.aborted) {
        console.log(`Worker aborted during channel polling at ${channel.channel_id}`);
        break;
      }

      // Inter-request delay between channels (not before the first one)
      if (i > 0) {
        const envDelay = parseInt(process.env.POLL_REQUEST_DELAY_MS, 10);
        const delay = Number.isFinite(envDelay) ? envDelay : DEFAULT_REQUEST_DELAY_MS;
        await sleep(delay);
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

           const newSignals = pendingSignalsForChannel(this.db, channel.channel_id, runId);

            // Dispatch analysis tasks immediately to pool with phase tracking
          for (const s of newSignals) {
            // Build display label: "Channel Name — YouTube Title"
            const signalTitle = s.title ?? s.video_id;
            this._displayLabels.set(s.video_id, `${channel.display_name ?? channel.channel_id} — ${signalTitle}`);

            taskPool.run(async () => {
              try {
                await analyzeSignal(this.db, s.video_id, llmConfig, signal, (phase, tokenCount) => {
                  this._phaseRegistry.set(s.video_id, phase, tokenCount);
                });
              } catch (err) {
                const msg = (err as Error).message;
                if (msg.includes('AbortError') || msg.includes('aborted')) {
                  // Signal was deleted by abort cleanup — don't count it
                  this._phaseRegistry.delete(s.video_id);
                  return;
                }
                console.error(`analyzeSignal failed for ${s.video_id}: ${msg}`);
              }

              // Only increment if NOT aborted (protects against late completions after abort)
              if (!signal?.aborted) {
                incrementDone(channel.channel_id);
              }

              // Clean up registry entry when task settles
              this._phaseRegistry.delete(s.video_id);
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
    await taskPool.drain();

    // Check if aborted before marking done
    if (signal?.aborted) {
      console.log(`Worker runId=${runId} stopped due to abort`);
      this._displayLabels.clear();
      this.activeRuns.delete(runId);
      return;
    }

    // Clear display labels after run completes
    this._displayLabels.clear();

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
      // Delete pending signals and their entity_mentions using signal-state module
      deletePendingForRun(this.db, rid);

      // Count remaining processed signals from this run
      const processedCount = countProcessedForRun(this.db, rid);

      // Always keep the run row so the UI can display "done-forced" status
      this.db.prepare(`
        UPDATE poll_runs SET status = 'done-forced', new_signal_count = ?, abort_time = ? WHERE id = ?
      `).run(processedCount, at, rid);
    });

    txn(runId, abortTime);
  }

}
