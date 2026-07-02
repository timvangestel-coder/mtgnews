import * as https from 'https';
import Database from 'better-sqlite3';

// ── RssError ────────────────────────────────────────────────────────

/** Typed error for RSS fetch failures with HTTP status awareness. */
export class RssError extends Error {
  constructor(
    message: string,
    public readonly channelId: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'RssError';
  }

  static isRateLimited(e: unknown): boolean {
    return e instanceof RssError && e.statusCode === 429;
  }

  static isBadChannel(e: unknown): boolean {
    return e instanceof RssError && e.statusCode === 404;
  }

  static isTransient(e: unknown): boolean {
    if (!(e instanceof RssError)) return false;
    return e.statusCode === 429 || (e.statusCode >= 500 && e.statusCode < 600);
  }
}

// ── RssFetchResult ──────────────────────────────────────────────────

export interface RssFetchResult {
  xml: string;
  status: number;
}

// ── BackoffState ────────────────────────────────────────────────────

export interface BackoffState {
  channelId: string;
  backoffUntilMs: number;
  consecutiveFailures: number;
  lastStatusCode: number | null;
}

// ── RssFeedFetcher ──────────────────────────────────────────────────

const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

/** Exponential backoff caps in milliseconds */
const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_BACKOFF_MS = 30 * 1000; // 30 seconds

/** Default inter-request delay */
export const DEFAULT_REQUEST_DELAY_MS = parseInt(process.env.POLL_REQUEST_DELAY_MS || '2000', 10);

interface FetcherOptions {
  /** Override the HTTP fetch function for testing */
  fetchWithStatus?: (url: string) => Promise<RssFetchResult>;
  /** Maximum number of retry attempts for transient errors */
  maxRetries?: number;
}

export class RssFeedFetcher {
  private fetchFn: (url: string) => Promise<RssFetchResult>;
  private maxRetries: number;

  constructor(
    private db: Database.Database,
    options: FetcherOptions = {}
  ) {
    this.fetchFn = options.fetchWithStatus ?? fetchUrlWithStatus;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Check if a channel is currently in backoff period. */
  isInBackoff(channelId: string): boolean {
    const row = this.db.prepare(
      'SELECT backoff_until_ms FROM rss_backoff WHERE channel_id = ?'
    ).get(channelId) as { backoff_until_ms: number } | undefined;

    if (!row) return false;
    return Date.now() < row.backoff_until_ms;
  }

  /** Fetch RSS XML for a channel with retry and backoff awareness. */
  async fetch(channelId: string): Promise<RssFetchResult> {
    // Check backoff
    if (this.isInBackoff(channelId)) {
      const state = this.getBackoffState(channelId);
      const until = state ? new Date(state.backoffUntilMs).toISOString() : 'unknown';
      throw new Error(`Channel ${channelId} in backoff until ${until}`);
    }

    let lastError: RssError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const result = await this.fetchFn(RSS_URL + channelId);
        // Success — reset backoff state
        this.resetBackoff(channelId);
        return result;
      } catch (err) {
        if (!(err instanceof RssError)) throw err;

        lastError = err;

        // Don't retry non-transient errors
        if (!RssError.isTransient(err)) throw err;

        // Record backoff before retry
        this.recordBackoff(channelId, err.statusCode);
      }
    }

    throw lastError!;
  }

  /** Get current backoff state for a channel. */
  getBackoffState(channelId: string): BackoffState | null {
    const row = this.db.prepare(
      'SELECT channel_id, backoff_until_ms, consecutive_failures, last_status_code FROM rss_backoff WHERE channel_id = ?'
    ).get(channelId) as { channel_id: string; backoff_until_ms: number; consecutive_failures: number; last_status_code: number | null } | undefined;

    if (!row) return null;
    return {
      channelId: row.channel_id,
      backoffUntilMs: row.backoff_until_ms,
      consecutiveFailures: row.consecutive_failures,
      lastStatusCode: row.last_status_code,
    };
  }

  /** Record a failure and update exponential backoff. */
  private recordBackoff(channelId: string, statusCode: number): void {
    const current = this.getBackoffState(channelId);
    const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;

    // Exponential growth: 30s -> 1m -> 2m -> 5m cap
    let backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
    if (backoffMs > BACKOFF_CAP_MS) backoffMs = BACKOFF_CAP_MS;

    const backoffUntilMs = Date.now() + backoffMs;

    this.db.prepare(`
      INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        backoff_until_ms = excluded.backoff_until_ms,
        consecutive_failures = excluded.consecutive_failures,
        last_status_code = excluded.last_status_code
    `).run(channelId, backoffUntilMs, consecutiveFailures, statusCode);
  }

  /** Reset backoff state on successful fetch. */
  private resetBackoff(channelId: string): void {
    this.db.prepare(
      'DELETE FROM rss_backoff WHERE channel_id = ?'
    ).run(channelId);
  }
}

// ── fetchUrlWithStatus ──────────────────────────────────────────────

/** Fetch a URL and return the body with HTTP status code. Throws RssError for non-2xx. */
function fetchUrlWithStatus(url: string): Promise<RssFetchResult> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ xml: body, status: res.statusCode });
        } else {
          reject(new RssError(
            `HTTP ${res.statusCode}: ${res.statusMessage ?? 'Request failed'}`,
            channelIdFromUrl(url),
            res.statusCode ?? 0
          ));
        }
      });
    }).on('error', (err) => {
      reject(new RssError(err.message, channelIdFromUrl(url), 0));
    });
  });
}

function channelIdFromUrl(url: string): string {
  const idx = url.lastIndexOf('channel_id=');
  if (idx !== -1) return url.slice(idx + 'channel_id='.length);
  return 'unknown';
}