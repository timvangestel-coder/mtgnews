import Database from 'better-sqlite3';
import { enqueuePollRun } from '../poll-scheduler';
import { abortPollRun } from '../abort';
import { getPollRunById, queryPollRunProgress, PollRunRow, PollRunProgressRow } from '../db/poll-runs';

export interface CurrentProgressResult {
  run: PollRunRow;
  progress: PollRunProgressRow[];
}

export class PollTriggerService {
  constructor(private db: Database.Database) {}

  /** Expose the database instance for worker spawning. */
  get database(): Database.Database {
    return this.db;
  }

  /** Enqueue a new poll run with optional lookback days (default 2). Returns the run ID. */
  enqueueRun(lookbackDays: number = 2): number {
    return enqueuePollRun(this.db, lookbackDays);
  }

  /** Abort an active poll run. Throws if run not found or already aborted. */
  abortRun(runId: number): void {
    abortPollRun(this.db, runId);
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
}