/**
 * Diagnostic script: simulate poll run for specific channels.
 * Tests RSS fetch + candidate discovery to see why channels show "failed" instead of "none".
 * 
 * Theory: In poll-run-manager.ts, any exception from pollChannel() -> catch -> upsertProgress('failed', 0).
 * A channel shows "none" only when pollChannel() returns successfully with newSignals===0.
 * So "failed" = an error was thrown during RSS fetch or processing.
 */

import * as https from 'https';

const CHANNELS = [
  { name: 'Alpha Investments', id: 'UCTp-iVOtTrKau0skmfZlo5Q' },
  { name: 'Benjamin Cowen', id: 'UCRvqjQPSeaWn-uEx-w0XOIg' },
  { name: 'Doctor Alex', id: 'UCGLAPJjQh7ege-N08u_GZrg' },
  { name: 'Kun Chen', id: 'UCb69t9ZkE5z1KvCmfJoaifA' },
  { name: 'StarTalk', id: 'UCqoAEDirJPjEUFcF2FklnBA' },
  { name: 'Two Minute Papers', id: 'UCbfYPyITQ-7l4upoX8nvctg' },
  { name: 'Veritasium', id: 'UCHnyfMqiRRG1u-2MsSQLbXA' },
  { name: 'Welch Labs', id: 'UConVfxXodg78Tzh5nNu85Ew' },
  { name: 'Zen van Riel', id: 'UC7TUInmEJ4NmYb-krFz-SuA' },
];

const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout after 15s'));
    }, 15000);
    
    https.get(url, (res) => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, statusMessage: res.statusMessage, length: body.length, body });
      });
    }).on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseRssFeed(xml) {
  if (!/<feed[^>]*>/.test(xml)) {
    throw new Error('Invalid RSS feed: missing <feed> root element');
  }
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const linkMatch = /<link[^>]*href="([^"]+)"/.exec(entryXml);
    if (linkMatch && linkMatch[1].includes('/shorts/')) continue;

    const idMatch = /<id>yt:video:([^<]+)<\/id>/.exec(entryXml);
    const titleMatch = /<title>([^<]+)<\/title>/.exec(entryXml);
    const publishedMatch = /<published>([^<]+)<\/published>/.exec(entryXml);

    if (idMatch && titleMatch && publishedMatch) {
      entries.push({
        video_id: idMatch[1],
        title: titleMatch[1],
        published_at: publishedMatch[1],
      });
    }
  }
  return entries;
}

async function main() {
  console.log('=== Poll Run Diagnosis ===\n');
  console.log('Testing RSS feeds for channels that showed "failed" instead of "none"\n');
  
  const now = Date.now();
  const lookbackDays = 2; // default from startRun()
  const cutoffMs = now - lookbackDays * 24 * 60 * 60 * 1000;

  for (const ch of CHANNELS) {
    process.stdout.write(`${ch.name} (${ch.id}): `);
    
    try {
      const result = await fetchUrl(RSS_URL + ch.id);
      
      if (result.status !== 200) {
        console.log(`HTTP ${result.status} ${result.statusMessage}`);
        continue;
      }

      let entries;
      try {
        entries = parseRssFeed(result.body);
      } catch (parseErr) {
        console.log(`PARSE ERROR: ${parseErr.message} (body length: ${result.length})`);
        continue;
      }

      const inWindow = entries.filter(e => new Date(e.published_at).getTime() >= cutoffMs);
      
      if (inWindow.length === 0) {
        console.log(`OK - RSS fetched (${entries.length} total entries), 0 in ${lookbackDays}d window -> would show "none"`);
      } else {
        console.log(`OK - RSS fetched, ${inWindow.length}/${entries.length} entries in ${lookbackDays}d window`);
        for (const e of inWindow) {
          console.log(`  - ${e.video_id}: ${e.title} (${e.published_at})`);
        }
      }
    } catch (err) {
      console.log(`FETCH ERROR: ${err.message} -> would show "FAILED"`);
    }
  }

  console.log('\n=== Analysis ===\n');
  console.log('Code flow: poll-run-manager.ts workerProcessRun()');
  console.log('  try { result = await pollChannel(...) }');
  console.log('  if (result.newSignals > 0) -> upsertProgress("processing", N)');
  console.log('  else                        -> upsertProgress("done", 0)   -> UI shows "none"');
  console.log('  catch {                     -> upsertProgress("failed", 0) -> UI shows "failed" }');
  console.log('\nSo "failed" means pollChannel() threw an exception.');
  console.log('The ONLY throw in pollChannel() for valid channels is:');
  console.log('  if (discovery.fetchErrors.length > 0) throw new Error("RSS fetch failed...")');
  console.log('\nA channel with no new videos should return successfully -> "none" (not "failed").');
}

main().catch(console.error);