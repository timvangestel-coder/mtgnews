#!/usr/bin/env node
/**
 * cleanup-shorts.mjs
 *
 * One-time cleanup script that removes YouTube Shorts signals from the DB.
 * Fetches RSS feeds for all watched channels, identifies Short video IDs,
 * and deletes matching signals by video_id.
 *
 * Safe to re-run (idempotent — no errors if Shorts already deleted).
 *
 * Usage: node scripts/cleanup-shorts.mjs
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

/**
 * Extract video IDs from YouTube Shorts entries in RSS XML.
 * Shorts use /shorts/ in their link href.
 */
function extractShortsVideoIds(xml) {
  const ids = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const linkMatch = /<link[^>]*href="([^"]+)"/.exec(entryXml);
    if (linkMatch && linkMatch[1].includes('/shorts/')) {
      const idMatch = /<id>yt:video:([^<]+)<\/id>/.exec(entryXml);
      if (idMatch) {
        ids.push(idMatch[1]);
      }
    }
  }

  return ids;
}

async function main() {
  // Get all channels from watchlist
  const channels = db.prepare(
    "SELECT channel_id FROM channels"
  ).all();

  if (channels.length === 0) {
    console.log('No channels in watchlist. Nothing to do.');
    db.close();
    process.exit(0);
  }

  console.log(`Found ${channels.length} channel(s). Fetching RSS feeds...\n`);

  // Collect all Shorts video IDs across all channels
  const allShortsIds = new Set();

  for (const { channel_id } of channels) {
    try {
      const xml = await fetchUrl(RSS_URL + channel_id);
      const shortsIds = extractShortsVideoIds(xml);
      for (const id of shortsIds) {
        allShortsIds.add(id);
      }
      if (shortsIds.length > 0) {
        console.log(`  ${channel_id}: found ${shortsIds.length} Short(s)`);
      }
    } catch (err) {
      console.log(`  ${channel_id}: RSS fetch failed (${err.message})`);
    }
  }

  if (allShortsIds.size === 0) {
    console.log('\nNo Shorts found in current RSS feeds. Nothing to delete.');
    db.close();
    process.exit(0);
  }

  console.log(`\nTotal unique Short video IDs from RSS: ${allShortsIds.size}`);

  // Find which of these Shorts exist in the signals table
  const shortsInDb = [];
  for (const videoId of allShortsIds) {
    const existing = db.prepare('SELECT video_id FROM signals WHERE video_id = ?').get(videoId);
    if (existing) {
      shortsInDb.push(videoId);
    }
  }

  if (shortsInDb.length === 0) {
    console.log('No Shorts found in signals table. Nothing to delete.');
    db.close();
    process.exit(0);
  }

  console.log(`Shorts in signals table: ${shortsInDb.length}`);


  // Clean up entity_mentions BEFORE deleting signals (FK constraint: signal_video_id REFERENCES signals(video_id))
  if (shortsInDb.length > 0) {
    const placeholders = shortsInDb.map(() => '?').join(',');
    db.prepare(`DELETE FROM entity_mentions WHERE signal_video_id IN (${placeholders})`).run(...shortsInDb);
  }

  // Delete matching signals
  let deletedCount = 0;
  const deleteSignal = db.prepare('DELETE FROM signals WHERE video_id = ?');

  for (const videoId of shortsInDb) {
    const result = deleteSignal.run(videoId);
    if (result.changes > 0) {
      deletedCount++;
      console.log(`  Deleted: ${videoId}`);
    }
  }

  console.log(`\n✅ Deleted ${deletedCount} Short signal(s) from signals table.`);
  db.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  db.close();
  process.exit(1);
});