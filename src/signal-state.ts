import Database from 'better-sqlite3';

/**
 * Signal processing state module.
 * Owns all signal processing_state transitions and predicates.
 */

const PENDING = 'pending';
const IRRELEVANT = 'irrelevant';
const SUMMARIZED = 'summarized';

/** Pure predicate: check if state is pending */
export function isPending(state: string): boolean {
  return state === PENDING;
}

/** Pure predicate: check if state is irrelevant */
export function isIrrelevant(state: string): boolean {
  return state === IRRELEVANT;
}

/** Pure predicate: check if state is summarized */
export function isSummarized(state: string): boolean {
  return state === SUMMARIZED;
}

/** Mark a signal as irrelevant by setting processing_state */
export function markIrrelevant(db: Database.Database, videoId: string): void {
  db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?")
    .run(IRRELEVANT, videoId);
}

/** Mark a signal as summarized by setting processing_state */
export function markSummarized(db: Database.Database, videoId: string): void {
  db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?")
    .run(SUMMARIZED, videoId);
}

/** Delete pending signals and their entity_mentions for a given poll run. Used by abort cleanup. */
export function deletePendingForRun(db: Database.Database, runId: number): void {
  // Delete entity_mentions for pending signals in this run first (FK cascade)
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
}

/** Count non-pending (processed) signals for a given poll run. */
export function countProcessedForRun(db: Database.Database, runId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM signals
    WHERE poll_run_id = ? AND processing_state != 'pending'
  `).get(runId) as { cnt: number };
  return row.cnt;
}

/** Query pending signals for a channel and run, for analysis dispatch. Returns rows with video_id. */
export function pendingSignalsForChannel(
  db: Database.Database,
  channelId: string,
  runId: number
): Array<{ video_id: string }> {
  return db.prepare(
    "SELECT video_id FROM signals WHERE channel_id = ? AND poll_run_id = ? AND processing_state = 'pending'"
  ).all(channelId, runId) as Array<{ video_id: string }>;
}
