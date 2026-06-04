import cron from 'node-cron';
import Database from 'better-sqlite3';
import { PollRunManager } from './poll-run-manager';

let _manager: PollRunManager | null = null;
let _disposable: cron.ScheduledTask | null = null;

/**
 * Recover "Stale Runs" on server startup.
 *
 * Detects PollRun rows stuck at status='running' with no completed_at,
 * caused by server shutdown mid-execution.
 *
 * For each stale run:
 * - Delete entity_mentions for pending signals
 * - Delete pending signals (processing_state = 'pending') by poll_run_id FK
 * - Count remaining processed signals
 * - If processed > 0: set status='done-forced', completed_at, new_signal_count
 * - If processed == 0: delete the run row entirely (no ghost entries)
 *
 * @returns number of stale runs recovered
 */
export function recoverStaleRuns(db: Database.Database): number {
  const staleRuns = db.prepare(
    "SELECT id FROM poll_runs WHERE status = 'running' AND completed_at IS NULL"
  ).all() as Array<{ id: number }>;

  if (staleRuns.length === 0) {
    return 0;
  }

  const txn = db.transaction((runId: number) => {
    // Delete entity_mentions for pending signals in this run
    db.prepare(`
      DELETE FROM entity_mentions WHERE signal_video_id IN (
        SELECT video_id FROM signals
        WHERE poll_run_id = ? AND processing_state = 'pending'
      )
    `).run(runId);

    // Delete pending signals by FK
    db.prepare(`
      DELETE FROM signals
      WHERE poll_run_id = ? AND processing_state = 'pending'
    `).run(runId);

    // Count remaining processed signals from this run
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE poll_run_id = ? AND processing_state != 'pending'
    `).get(runId) as { cnt: number };

    if (row.cnt > 0) {
      // Keep run with done-forced status
      db.prepare(`
        UPDATE poll_runs SET status = 'done-forced', completed_at = ?, new_signal_count = ? WHERE id = ?
      `).run(Date.now(), row.cnt, runId);

      console.log(`[scheduler] Recovered stale run #${runId}: ${row.cnt} signal(s) kept -> done-forced`);
    } else {
      // Delete child progress rows before deleting the run
      db.prepare(`DELETE FROM poll_run_progress WHERE poll_run_id = ?`).run(runId);

      // Delete run entirely (no ghost entries)
      db.prepare(`DELETE FROM poll_runs WHERE id = ?`).run(runId);

      console.log(`[scheduler] Recovered stale run #${runId}: 0 signals kept -> deleted`);
    }
  });

  for (const run of staleRuns) {
    txn(run.id);
  }

  return staleRuns.length;
}

/**
 * Start daily scheduled polling at midnight UTC.
 * Uses PollRunManager.startRun() for the same code path as manual trigger.
 */
export function startScheduledPolling(manager: PollRunManager): void {
  _manager = manager;
  _disposable = cron.schedule('0 0 * * *', () => {
    if (_manager) {
      _manager.startRun(2).catch(console.error);
    }
  });
}

/**
 * Stop the scheduled polling job.
 */
export function stopScheduledPolling(): void {
  if (_disposable) {
    _disposable.stop();
    _disposable = null;
  }
  _manager = null;
}
