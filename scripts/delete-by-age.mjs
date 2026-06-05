import Database from 'better-sqlite3';

const db = new Database('./data/mtgnews.db');

// Parse args
const maxAgeDays = parseInt(process.argv[2], 10);
const execute = process.argv.includes('--execute');

if (!maxAgeDays || maxAgeDays <= 0) {
  console.error('Usage: node scripts/delete-by-age.mjs <maxAgeDays> [--execute]');
  console.error('  maxAgeDays: delete signals whose published_at is within this many days from now');
  console.error('  --execute: actually perform deletions (without this flag, dry run only)');
  process.exit(1);
}

const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

// Find signals to delete (published within last N days)
const toDelete = db.prepare(`
  SELECT video_id, published_at, title, poll_run_id FROM signals WHERE published_at >= ?
`).all(cutoff);

console.log(`Found ${toDelete.length} signals published within ${maxAgeDays} day(s) (cutoff: ${cutoff})`);

if (toDelete.length === 0) {
  console.log('Nothing to delete.');
  db.close();
  process.exit(0);
}

// Collect affected poll_run_ids for counter recalculation
const affectedRunIds = [...new Set(toDelete.map(s => s.poll_run_id).filter(Boolean))];

if (!execute) {
  console.log('\n--- DRY RUN ---');
  console.log(`Would delete ${toDelete.length} signal(s):`);
  for (const s of toDelete) {
    console.log(`  ${s.video_id} | published: ${s.published_at} | run: ${s.poll_run_id ?? 'null'} | ${s.title}`);
  }
  if (affectedRunIds.length > 0) {
    console.log(`\nWould recalculate counters for poll_run(s): ${affectedRunIds.join(', ')}`);
  }
  console.log('\nRe-run with --execute to actually delete.');
  db.close();
  process.exit(0);
}

// --- EXECUTE ---
console.log(`Deleting ${toDelete.length} signal(s)...`);

const videoIds = toDelete.map(s => s.video_id);

// Delete entity_mentions first (cascade)
db.prepare('DELETE FROM entity_mentions WHERE signal_video_id IN (' + videoIds.map(() => '?').join(',') + ')').run(...videoIds);

// Delete signals
db.prepare('DELETE FROM signals WHERE video_id IN (' + videoIds.map(() => '?').join(',') + ')').run(...videoIds);

console.log(`Deleted ${toDelete.length} signal(s) and associated entity_mentions.`);

// Recalculate poll_runs.new_signal_count from remaining signals
for (const runId of affectedRunIds) {
  const summarized = db.prepare(
    "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND processing_state IN ('summarized', 'irrelevant')"
  ).get(runId);
  const newCount = summarized?.cnt ?? 0;

  db.prepare('UPDATE poll_runs SET new_signal_count = ? WHERE id = ?').run(newCount, runId);
  console.log(`Recalculated poll_run ${runId}: new_signal_count = ${newCount}`);

  // Check if run has zero signals left — clean up progress rows
  const anyLeft = db.prepare(
    "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ?"
  ).get(runId);
  if (anyLeft.cnt === 0) {
    db.prepare('DELETE FROM poll_run_progress WHERE poll_run_id = ?').run(runId);
    console.log(`No signals remain for run ${runId} — deleted progress rows.`);
  } else {
    // Recalculate per-channel progress counters
    const channels = db.prepare(
      "SELECT DISTINCT channel_id FROM poll_run_progress WHERE poll_run_id = ?"
    ).all(runId);
    for (const ch of channels) {
      const found = db.prepare(
        "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND channel_id = ?"
      ).get(runId, ch.channel_id);
      const done = db.prepare(
        "SELECT COUNT(*) as cnt FROM signals WHERE poll_run_id = ? AND channel_id = ? AND processing_state IN ('summarized', 'irrelevant')"
      ).get(runId, ch.channel_id);

      db.prepare(`
        UPDATE poll_run_progress 
        SET signals_found = ?, signals_done = ?, updated_at = ? 
        WHERE poll_run_id = ? AND channel_id = ?
      `).run(found.cnt, done.cnt, Date.now(), runId, ch.channel_id);

      // Update status if all done
      if (done.cnt >= found.cnt && found.cnt > 0) {
        db.prepare(
          "UPDATE poll_run_progress SET status = 'done', updated_at = ? WHERE poll_run_id = ? AND channel_id = ?"
        ).run(Date.now(), runId, ch.channel_id);
      }
    }
  }
}

console.log('\nDone.');
db.close();