import Database from 'better-sqlite3';
import { getActiveRun } from './poll-scheduler';

/**
 * Abort an active PollRun cooperatively.
 *
 * Logic:
 * 1. Fire AbortController -> cancels in-flight LLM HTTP requests + stops worker between tasks
 * 2. Delete unsummarized signals by poll_run_id FK (no timestamp window race)
 * 3. Clean entity_mentions for those signals
 * 4. Always set status = 'done-forced' with correct new_signal_count (even if zero).
 *    The run row is never deleted — the UI needs it to display abort status.
 */
export function abortPollRun(db: Database.Database, runId: number): void {
  // Step 1: cancel in-flight work via AbortController
  const active = getActiveRun(runId);
  if (active) {
    console.log(`ABORT runId=${runId}: firing AbortController to cancel worker`);
    active.controller.abort('Poll run aborted by user');
  }

  // Fetch current run
  const run = db.prepare(`
    SELECT id, triggered_at, status FROM poll_runs WHERE id = ?
  `).get(runId) as { id: number; triggered_at: number; status: string } | undefined;

  if (!run) {
    throw new Error(`PollRun #${runId} not found`);
  }

  if (run.status === 'done-forced') {
    throw new Error(`PollRun #${runId} already aborted (done-forced)`);
  }

  const abortTime = Date.now();
  console.log(`ABORT runId=${runId} triggered_at=${run.triggered_at} abort_time=${abortTime}`);
  console.log('signals before delete:', JSON.stringify(db.prepare('SELECT video_id, created_at, processed_at, poll_run_id FROM signals').all()));

  // Use explicit transaction for atomicity and visibility
  const txn = db.transaction((rid: number, at: number) => {
    console.log(`TXN: deleting signals with poll_run_id=${rid}`);

    // Delete entity_mentions for signals belonging to this run that are unsummarized
    db.prepare(`
      DELETE FROM entity_mentions WHERE signal_video_id IN (
        SELECT video_id FROM signals
        WHERE poll_run_id = ? AND processed_at IS NULL
      )
    `).run(rid);

    // Delete unsummarized signals by FK (no timestamp window -> no race)
    db.prepare(`
      DELETE FROM signals
      WHERE poll_run_id = ? AND processed_at IS NULL
    `).run(rid);

    // Count remaining processed signals from this run
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE poll_run_id = ? AND processed_at IS NOT NULL
    `).get(rid) as { cnt: number };

    // Always keep the run row so the UI can display "done-forced" status.
    db.prepare(`
      UPDATE poll_runs SET status = 'done-forced', new_signal_count = ?, abort_time = ? WHERE id = ?
    `).run(row.cnt, at, rid);
  });

  txn(runId, abortTime);
}
