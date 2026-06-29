// NOTE: All queries reading channels/signals/entity_mentions/signal_chat/poll_run_progress must filter
// deleted rows using softDeleteFilter(alias). See ADR-0015 (issue #185).
import * as https from 'https';
import Database from 'better-sqlite3';
import { softDeleteFilter } from './db/soft-delete-filter';

export interface RssCandidate {
  video_id: string;
  channel_id: string;
  title: string;
  published_at: string;
}

export interface ChannelInfo {
  display_name: string;
  avatar_url: string;
}

const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const UC_ID_PATTERN = 'UC[A-Za-z0-9_-]{20,24}';

export function parseRssFeed(xml: string): RssCandidate[] {
  if (!/<feed[^>]*>/.test(xml)) {
    throw new Error('Invalid RSS feed: missing <feed> root element');
  }
  const entries: RssCandidate[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];

    // Skip YouTube Shorts: entries with /shorts/ in the link href
    const linkMatch = /<link[^>]*href="([^"]+)"/.exec(entryXml);
    if (linkMatch && linkMatch[1].includes('/shorts/')) {
      continue;
    }

    const idMatch = /<id>yt:video:([^<]+)<\/id>/.exec(entryXml);
    const titleMatch = /<title>([^<]+)<\/title>/.exec(entryXml);
    const publishedMatch = /<published>([^<]+)<\/published>/.exec(entryXml);

    if (idMatch && titleMatch && publishedMatch) {
      entries.push({
        video_id: idMatch[1],
        channel_id: '',
        title: titleMatch[1],
        published_at: publishedMatch[1],
      });
    }
  }

  return entries;
}

/**
 * Extract video IDs from YouTube Shorts entries in an RSS feed.
 * Used by the cleanup script to identify Shorts for deletion.
 */
export function extractShortsVideoIds(xml: string): string[] {
  const ids: string[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

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

export function parseChannelInfo(xml: string): ChannelInfo | null {
  const titleMatch = /<title>([^<]+)<\/title>/.exec(xml);
  const linkMatch = /<link rel="alternate" href="([^"]+)"/.exec(xml);

  if (!titleMatch || !linkMatch) return null;

  // extract channel handle/ID from URL for avatar
  const url = linkMatch[1];
  const handleMatch = /youtube\.com\/([^/?]+)/.exec(url);
  const channelHandle = handleMatch ? handleMatch[1] : '';

  // use youtube default avatar URL pattern
  const avatarUrl = channelHandle
    ? `https://img.youtube.com/vi/placeholder/default.jpg`
    : '';

  return {
    display_name: titleMatch[1],
    avatar_url: avatarUrl,
  };
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

function fetchRssSync(channelId: string): Promise<string> {
  return fetchUrl(RSS_URL + channelId);
}

export interface ResolveChannelOptions {
  fetchPage?: (url: string) => Promise<string>;
}

/**
 * Resolve any YouTube channel identifier to a UC... browse ID.
 * - Raw UC ID: returned as-is
 * - /channel/UC... URL: extracted via regex
 * - @handle or full URL: fetches page HTML and extracts browseId/channelId
 */
export async function resolveChannelId(
  input: string,
  options: ResolveChannelOptions = {}
): Promise<string> {
  // Case 1: raw UC ID
  const rawUcMatch = input.trim().match(new RegExp(`^${UC_ID_PATTERN}$`));
  if (rawUcMatch) {
    return rawUcMatch[0];
  }

  // Case 2: /channel/UC... URL
  const channelUrlMatch = new RegExp(`\\/channel\\/(${UC_ID_PATTERN})`).exec(input);
  if (channelUrlMatch) {
    return channelUrlMatch[1];
  }

  // Case 3: handle or URL — fetch page HTML and extract browseId
  const fetchFn = options.fetchPage || fetchPageHtml;

  // Build URL to fetch
  let fetchUrl: string;
  if (input.startsWith('http')) {
    fetchUrl = input;
  } else if (input.startsWith('@')) {
    fetchUrl = `https://www.youtube.com/${input}`;
  } else {
    fetchUrl = `https://www.youtube.com/@${input}`;
  }

  const html = await fetchFn(fetchUrl);

  // Try multiple patterns to extract UC ID from page HTML
  const browseIdMatch = new RegExp(`"browseId":"(${UC_ID_PATTERN})"`).exec(html);
  if (browseIdMatch) {
    return browseIdMatch[1];
  }

  const channelIdMatch = new RegExp(`"channelId"\\s*:\\s*"(${UC_ID_PATTERN})"`).exec(html);
  if (channelIdMatch) {
    return channelIdMatch[1];
  }

  throw new Error(`Could not resolve channel ID from: ${input}`);
}

function fetchPageHtml(url: string): Promise<string> {
  return fetchUrl(url);
}

export interface DiscoveryOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  lookbackDays?: number;
}

export interface ChannelDiscoveryResult {
  candidates: RssCandidate[];
  duplicateCount: number;
  /** Channel IDs whose RSS fetch failed */
  fetchErrors: string[];
}

/**
 * Discover new video candidates from RSS feeds.
 * Returns per-channel results with candidates and duplicate counts,
 * eliminating the need for a second RSS fetch to count duplicates.
 */
export async function discoverCandidates(
  db: Database.Database,
  channelIds: string[],
  options: DiscoveryOptions = {}
): Promise<ChannelDiscoveryResult> {
  if (channelIds.length === 0) return { candidates: [], duplicateCount: 0, fetchErrors: [] };

  const fetchFn = options.fetchRss || fetchRssSync;

  // get already-processed video IDs
  const existing = db.prepare(`SELECT video_id FROM signals s WHERE 1=1 ${softDeleteFilter('s')}`).all() as { video_id: string }[];
  const processedIds = new Set(existing.map((r) => r.video_id));

  const candidates: RssCandidate[] = [];
  let duplicateCount = 0;
  const fetchErrors: string[] = [];

  // compute cutoff timestamp for lookback filtering
  const cutoffMs = options.lookbackDays != null
    ? Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000
    : null;

  for (const channelId of channelIds) {
    try {
      const xml = await fetchFn(channelId);
      const entries = parseRssFeed(xml);

      for (const entry of entries) {
        entry.channel_id = channelId;

        // skip if already processed
        if (processedIds.has(entry.video_id)) {
          duplicateCount++;
          continue;
        }

        // skip if older than lookback window
        if (cutoffMs != null) {
          const publishedMs = new Date(entry.published_at).getTime();
          if (publishedMs < cutoffMs) continue;
        }

        candidates.push(entry);
      }
    } catch {
      fetchErrors.push(channelId);
    }
  }

  return { candidates, duplicateCount, fetchErrors };
}

export async function fetchChannelInfo(
  channelId: string,
  options: DiscoveryOptions = {}
): Promise<ChannelInfo | null> {
  try {
    const fetchFn = options.fetchRss || fetchRssSync;
    const xml = await fetchFn(channelId);
    return parseChannelInfo(xml);
  } catch {
    return null;
  }
}
