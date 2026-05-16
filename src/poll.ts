import Database from 'better-sqlite3';
import { listChannels } from './db/watchlist';
import { discoverCandidates, RssCandidate, DiscoveryOptions } from './rss-discovery';
import { TranscriptionSegment, TranscriptionOptions } from './transcription';

export interface PollResult {
  newSignals: number;
  skippedDuplicates: number;
  skippedNoCaptions: string[];
}

export interface PollOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  extractCaptions?: (videoId: string) => Promise<TranscriptionSegment[]>;
}

export async function pollChannel(
  db: Database.Database,
  channelId: string,
  options: PollOptions = {}
): Promise<PollResult> {
  // verify channel exists in watchlist
  const channels = listChannels(db);
  if (!channels.find((ch) => ch.channel_id === channelId)) {
    throw new Error(`Channel ${channelId} not found in watchlist`);
  }

  // step 1: discover new video candidates via RSS (duplicates already filtered)
  const candidates = await discoverCandidates(db, [channelId], {
    fetchRss: options.fetchRss,
  } as DiscoveryOptions);

  // count duplicates: parse RSS raw to see total entries vs candidates
  const processedIds = new Set(
    (db.prepare('SELECT video_id FROM signals').all() as { video_id: string }[]).map(
      (r) => r.video_id
    )
  );

  // count how many entries existed in RSS but were already processed
  let skippedDuplicates = 0;
  if (options.fetchRss) {
    const xml = await options.fetchRss(channelId);
    const { parseRssFeed } = await import('./rss-discovery');
    const allEntries = parseRssFeed(xml);
    skippedDuplicates = allEntries.filter((e) => processedIds.has(e.video_id)).length;
  }

  const extractFn = options.extractCaptions;
  let newSignals = 0;
  const skippedNoCaptions: string[] = [];

  const insertSignal = db.prepare(
    'INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const candidate of candidates) {
    // step 2: extract transcription
    let segments: TranscriptionSegment[];
    try {
      if (extractFn) {
        segments = await extractFn(candidate.video_id);
      } else {
        // real yt-dlp path
        const { extractCaptions: realExtract } = await import('./transcription');
        segments = await realExtract(candidate.video_id);
      }
    } catch (err) {
      console.error(`Failed to extract captions for ${candidate.video_id}: ${(err as Error).message}`);
      skippedNoCaptions.push(candidate.video_id);
      continue;
    }

    // step 3: skip if no captions
    if (segments.length === 0) {
      console.log(`Skipping ${candidate.video_id}: no captions available`);
      skippedNoCaptions.push(candidate.video_id);
      continue;
    }

    // step 4: persist signal
    insertSignal.run(
      candidate.video_id,
      candidate.channel_id,
      candidate.title,
      candidate.published_at,
      JSON.stringify(segments),
      Date.now()
    );
    newSignals++;
  }

  return {
    newSignals,
    skippedDuplicates,
    skippedNoCaptions,
  };
}
