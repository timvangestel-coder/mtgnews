import Database from 'better-sqlite3';

/** In-memory registry of active poll runs -> AbortController + worker promise */
const activeRuns = new Map<number, { controller: AbortController; worker: Promise<void> }>();

export function enqueuePollRun(db: Database.Database, lookbackDays: number = 2): number {
  const stmt = db.prepare(
    'INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)'
  );
  const result = stmt.run(Date.now(), 'running', lookbackDays);
  return Number(result.lastInsertRowid);
}

/** Store the AbortController + worker promise for a run */
export function registerRun(runId: number, controller: AbortController, worker: Promise<void>): void {
  activeRuns.set(runId, { controller, worker });
}

/** Remove registry entry when run finishes */
export function unregisterRun(runId: number): void {
  activeRuns.delete(runId);
}

/** Get the AbortController for a running poll. Returns undefined if not found or already aborted. */
export function getActiveRun(runId: number): { controller: AbortController; worker: Promise<void> } | undefined {
  return activeRuns.get(runId);
}