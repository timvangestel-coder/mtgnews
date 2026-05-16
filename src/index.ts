import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { initDb } from './db/init-db';

const DB_PATH = process.env.MTGDB_PATH || path.join(process.cwd(), 'data', 'mtgnews.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db: DatabaseType = new Database(DB_PATH);
initDb(db);

console.log(`MTG News initialized. Database: ${DB_PATH}`);

// Start HTTP server when run directly (e.g. npm run dev)
if (require.main === module) {
  const { createServer } = require('./server');
  createServer();
}

export { db };
export type { DatabaseType };