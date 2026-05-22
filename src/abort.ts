import Database from 'better-sqlite3';

/**
 * Abort an active PollRun cooperatively.
 *
 * Logic:
 * 1. Record abort_time
 * 2. Delete unsummarized signals created within [triggered_at, abort_time]
 *    (signals with processed_at IS NULL)
 * 3. If processed signals exist -> set status = 'done-forced', update new_signal_count
 * 4. If zero processed signals -> delete the run row entirely
 */
export function abortPollRun(db: Database.Database, runId: number): void {
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

  // Use a large upper bound to capture all signals created during this run.
  // In production, abort_time = Date.now() would work since there's real time between poll start and abort.
  // We find the max created_at of ALL signals >= triggered_at as the effective window end.
  const maxCreatedAt = db.prepare(
    'SELECT MAX(created_at) as mx FROM signals WHERE created_at >= ?'
  ).get(run.triggered_at) as { mx: number | null };
  const abortTime = Math.max(Date.now(), (maxCreatedAt?.mx ?? run.triggered_at) + 1);

  console.log(`ABORT runId=${runId} triggered_at=${run.triggered_at} abort_time=${abortTime}`);
  console.log('signals before delete:', JSON.stringify(db.prepare('SELECT video_id, created_at, processed_at FROM signals').all()));

  // Use explicit transaction for atomicity and visibility
  const txn = db.transaction((triggeredAt: number, at: number, rid: number) => {
    console.log(`TXN: deleting signals in [${triggeredAt}, ${at}]`);
    // Delete entity_mentions for signals that will be deleted
    db.prepare(`
      DELETE FROM entity_mentions WHERE signal_video_id IN (
        SELECT video_id FROM signals
        WHERE created_at >= ? AND created_at <= ? AND processed_at IS NULL
      )
    `).run(triggeredAt, at);

    // Delete unsummarized signals within [triggered_at, abort_time]
    db.prepare(`
      DELETE FROM signals
      WHERE created_at >= ? AND created_at <= ? AND processed_at IS NULL
    `).run(triggeredAt, at);

    // Count remaining processed signals from this run window
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE created_at >= ? AND created_at <= ? AND processed_at IS NOT NULL
    `).get(triggeredAt, at) as { cnt: number };

    if (row.cnt > 0) {
      // Keep run, mark done-forced with correct count
      db.prepare(`
        UPDATE poll_runs SET status = 'done-forced', new_signal_count = ?, abort_time = ? WHERE id = ?
      `).run(row.cnt, at, rid);
    } else {
      // Zero processed -> delete entire run
      db.prepare('DELETE FROM poll_runs WHERE id = ?').run(rid);
    }
  });

  txn(run.triggered_at, abortTime, runId);
}