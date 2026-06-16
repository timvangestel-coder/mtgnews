#!/usr/bin/env tsx
/**
 * backfill-compact-text.ts
 *
 * Re-runs LLM analysis on existing signals with NULL `compact_text`,
 * populating the column so multi-signal chat works for historical data.
 *
 * The script is idempotent — safe to run multiple times without duplicating work.
 * Only signals where compact_text IS NULL are processed.
 *
 * Usage:
 *   tsx scripts/backfill-compact-text.ts
 *
 * Environment (optional):
 *   LLM_CONCURRENCY  - max parallel LLM calls (default: 3)
 *   LLM_ENDPOINT     - LLM API endpoint (defaults to local instance)
 *   LLM_MODEL        - model name (defaults to qwen/qwen3.6-27b)
 *   MTGDB_PATH       - path to SQLite database (defaults to data/mtgnews.db)
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { join } from 'path';
import { initDb } from '../src/db/init-db.js';
import { backfillCompactText, BackfillResult } from '../src/backfill-compact-text.js';

const DB_PATH = process.env.MTGDB_PATH || join(__dirname, '..', 'data', 'mtgnews.db');
const db = new Database(DB_PATH);
initDb(db);

console.log(`Backfilling compact_text (db: ${DB_PATH})\n`);

async function main() {
  const result: BackfillResult = await backfillCompactText(db);

  console.log(`\nSummary:`);
  console.log(`  Total signals needing backfill: ${result.total}`);
  console.log(`  Successfully backfilled:        ${result.successes}`);
  console.log(`  Failed:                         ${result.failures}`);

  db.close();

  if (result.failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  db.close();
  process.exit(1);
});