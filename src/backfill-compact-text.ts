/**
 * backfill-compact-text.ts
 *
 * Re-runs LLM analysis on existing signals with NULL `compact_text`,
 * populating the column so multi-signal chat works for historical data.
 *
 * Uses the same analyzeSignal() path as normal polling, respecting
 * the global ConcurrencyPool and LLM_CONCURRENCY limit.
 */

import Database from 'better-sqlite3';
import { ConcurrencyPool } from './concurrency-pool.ts';
import { analyzeSignal, getLlmConfig } from './llm.ts';

export interface BackfillResult {
  /** Total signals found with NULL compact_text */
  total: number;
  /** Signals successfully analyzed and updated */
  successes: number;
  /** Signals that failed analysis */
  failures: number;
}

/**
 * Query for signals that need backfilling (compact_text IS NULL).
 */
function findSignalsNeedingBackfill(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT video_id FROM signals WHERE compact_text IS NULL AND processing_state != 'irrelevant'"
  ).all() as Array<{ video_id: string }>;

  return rows.map((r) => r.video_id);
}

/**
 * Backfill compact_text for all signals that are missing it.
 *
 * @param db - SQLite database connection
 * @returns result with total, successes, failures counts
 */
export async function backfillCompactText(db: Database.Database): Promise<BackfillResult> {
  const videoIds = findSignalsNeedingBackfill(db);
  const total = videoIds.length;

  if (total === 0) {
    console.log('No signals need backfill — all have compact_text.');
    return { total: 0, successes: 0, failures: 0 };
  }

  console.log(`Found ${total} signal(s) needing compact_text backfill.`);

  const concurrency = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
  const pool = new ConcurrencyPool(concurrency);
  const config = getLlmConfig();

  let successes = 0;
  let failures = 0;

  for (const videoId of videoIds) {
    pool.run(async () => {
      console.log(`Analyzing ${videoId}...`);
      const result = await analyzeSignal(db, videoId, config);

      if (result.success) {
        successes++;
        console.log(`  ✓ ${videoId} backfilled`);
      } else {
        failures++;
        console.error(`  ✗ ${videoId} failed: ${result.error}`);
      }
    });
  }

  await pool.drain();

  console.log(`Backfill complete: ${successes}/${total} succeeded, ${failures}/${total} failed.`);

  return { total, successes, failures };
}