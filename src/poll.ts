import Database from 'better-sqlite3';
import { listChannels } from './db/watchlist';
import { discoverCandidates, RssCandidate, DiscoveryOptions } from './rss-discovery';
import { TranscriptionSegment, groupSegments } from './transcription';

export interface IngestResult {
  ingested: boolean;
  duplicate: boolean;
  noCaptions: boolean;
}

export interface IngestOptions {
  extractCaptions?: (videoId: string) => Promise<TranscriptionSegment[]>;
  runId?: number;
}

/**
 * Ingest a single RSS candidate into the signals table.
 * Performs: duplicate check → caption extraction → segment grouping → DB insert.
 */
export async function ingestSignal(
  db: Database.Database,
  candidate: RssCandidate,
  options: IngestOptions = {}
): Promise<IngestResult> {
  // Check for duplicate
  const existing = db.prepare('SELECT video_id FROM signals WHERE video_id = ?').get(candidate.video_id);
  if (existing) {
    return { ingested: false, duplicate: true, noCaptions: false };
  }

  // Extract captions
  let segments: TranscriptionSegment[];
  try {
    if (options.extractCaptions) {
      segments = await options.extractCaptions(candidate.video_id);
    } else {
      const { extractCaptions: realExtract } = await import('./transcription');
      segments = await realExtract(candidate.video_id);
    }
  } catch {
    return { ingested: false, duplicate: false, noCaptions: true };
  }

  // Skip if no captions
  if (segments.length === 0) {
    return { ingested: false, duplicate: false, noCaptions: true };
  }

  // Group and persist
  const grouped = groupSegments(segments);
  db.prepare(
    'INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    candidate.video_id,
    candidate.channel_id,
    candidate.title,
    candidate.published_at,
    JSON.stringify(grouped),
    Date.now(),
    options.runId ?? null
  );

  return { ingested: true, duplicate: false, noCaptions: false };
}

export interface PollResult {
  newSignals: number;
  skippedDuplicates: number;
  skippedNoCaptions: string[];
}

export interface PollOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  extractCaptions?: (videoId: string) => Promise<TranscriptionSegment[]>;
  lookbackDays?: number;
  runId?: number;
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

  // step 1: discover new video candidates via RSS (single fetch — duplicates counted inline)
  const discovery = await discoverCandidates(db, [channelId], {
    fetchRss: options.fetchRss,
    lookbackDays: options.lookbackDays,
  } as DiscoveryOptions);

  // If the single channel's RSS fetch failed, throw so the worker marks it 'failed'
  if (discovery.fetchErrors.length > 0) {
    throw new Error(`RSS fetch failed for channel ${channelId}`);
  }

  const { candidates, duplicateCount } = discovery;
  let newSignals = 0;
  const skippedNoCaptions: string[] = [];

  // step 2: ingest each candidate through the deep pipeline
  for (const candidate of candidates) {
    const result = await ingestSignal(db, candidate, {
      extractCaptions: options.extractCaptions,
      runId: options.runId,
    });

    if (result.ingested) {
      newSignals++;
    } else if (result.noCaptions) {
      console.log(`Skipping ${candidate.video_id}: no captions available`);
      skippedNoCaptions.push(candidate.video_id);
    }
  }

  return {
    newSignals,
    skippedDuplicates: duplicateCount,
    skippedNoCaptions,
  };
}
