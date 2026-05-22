import Database from 'better-sqlite3';

const db = new Database('./data/mtgnews.db');

// Delete entity_mentions for unprocessed signals first
const unproc = db.prepare("SELECT video_id FROM signals WHERE processed_at IS NULL").all();
console.log('Found', unproc.length, 'unprocessed signals');

for (const row of unproc) {
  db.prepare('DELETE FROM entity_mentions WHERE signal_video_id = ?').run(row.video_id);
  console.log('  cleared entities for', row.video_id);
}

// Delete the signals
const result = db.prepare("DELETE FROM signals WHERE processed_at IS NULL").run();
console.log('Deleted', result.changes, 'signals');

// Verify
const remaining = db.prepare("SELECT COUNT(*) as cnt FROM signals WHERE processed_at IS NULL").get();
console.log('Unprocessed remaining:', remaining.cnt);

db.close();