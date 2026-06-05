import Database from 'better-sqlite3';

const db = new Database('./data/mtgnews.db');

// All signals in run 100022
const allSignals = db.prepare(`
  SELECT video_id, processing_state, length(transcription) as tlen 
  FROM signals WHERE poll_run_id = 100022
`).all();

console.log('=== Run 100022 signal states ===');
for (const s of allSignals) {
  console.log(`  ${s.video_id} | state: ${s.processing_state} | transcription_len: ${s.tlen}`);
}

// Count by state
const counts = {};
for (const s of allSignals) {
  counts[s.processing_state] = (counts[s.processing_state] || 0) + 1;
}
console.log('\nCounts by state:', counts);

db.close();