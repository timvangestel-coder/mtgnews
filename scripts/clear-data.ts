#!/usr/bin/env tsx
/**
 * clear-data.ts
 *
 * Clears all database tables except 'channels'.
 * Prompts for confirmation before proceeding.
 *
 * Usage: npm run cleardb
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

// Load .env if present
const envPath = join(__dirname, '..', '.env');
try {
  const env = readFileSync(envPath, 'utf-8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
} catch {
  // .env not found, ignore
}

const dbPath = join(__dirname, '..', 'data', 'mtgnews.db');
const db = new Database(dbPath);

// Ask for confirmation
const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question(
  '⚠️  This will delete all data except channels. Are you sure? (type "yes" to confirm): ',
  (answer: string) => {
    rl.close();

    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      db.close();
      process.exit(0);
    }

    // Disable FK checks so we can delete in any order
    db.pragma('foreign_keys = OFF');

    // Get all tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];

    // Keep only 'channels' table
    const tablesToClear = tables.map(t => t.name).filter(name => name !== 'channels');

    console.log('\nTables to clear:', tablesToClear);

    for (const tableName of tablesToClear) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number };
        console.log(`  Deleted ${count.cnt} rows from ${tableName}`);
        db.prepare(`DELETE FROM "${tableName}"`).run();
      } catch (err) {
        console.log(`  Skipping ${tableName}: ${(err as Error).message}`);
      }
    }

    // Re-enable FK checks
    db.pragma('foreign_keys = ON');

    console.log('\n✅ Done. Channels table preserved.');
    db.close();
  }
);