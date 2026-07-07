import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RssError, RssFeedFetcher } from './rss-feed-fetcher';
import { initDb } from './db/init-db';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  // Ensure rss_backoff table exists for tests
  db.exec(`
    CREATE TABLE IF NOT EXISTS rss_backoff (
      channel_id TEXT PRIMARY KEY,
      backoff_until_ms INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 1,
      last_status_code INTEGER
    )
  `);
  return db;
}

describe('RssError', () => {
  describe('isRateLimited', () => {
    it('returns true for 429 status code', () => {
      const err = new RssError('Too many requests', 'UC123', 429);
      expect(RssError.isRateLimited(err)).toBe(true);
    });

    it('returns false for non-429 status codes', () => {
      const err = new RssError('Not found', 'UC123', 404);
      expect(RssError.isRateLimited(err)).toBe(false);
    });
  });

  describe('isBadChannel', () => {
    it('returns true for 404 status code', () => {
      const err = new RssError('Not found', 'UC123', 404);
      expect(RssError.isBadChannel(err)).toBe(true);
    });

    it('returns false for non-404 status codes', () => {
      const err = new RssError('Server error', 'UC123', 500);
      expect(RssError.isBadChannel(err)).toBe(false);
    });
  });

  describe('isTransient', () => {
    it('returns true for 5xx status codes', () => {
      const err500 = new RssError('Server error', 'UC123', 500);
      const err502 = new RssError('Bad gateway', 'UC123', 502);
      const err503 = new RssError('Unavailable', 'UC123', 503);
      expect(RssError.isTransient(err500)).toBe(true);
      expect(RssError.isTransient(err502)).toBe(true);
      expect(RssError.isTransient(err503)).toBe(true);
    });

    it('returns true for 429 status code', () => {
      const err = new RssError('Too many requests', 'UC123', 429);
      expect(RssError.isTransient(err)).toBe(true);
    });

    it('returns false for client errors like 404', () => {
      const err = new RssError('Not found', 'UC123', 404);
      expect(RssError.isTransient(err)).toBe(false);
    });

    it('returns false for success status codes', () => {
      const err = new RssError('ok', 'UC123', 200);
      expect(RssError.isTransient(err)).toBe(false);
    });
  });

  describe('properties', () => {
    it('stores statusCode, channelId, and message', () => {
      const err = new RssError('fetch failed', 'UCabc', 503);
      expect(err.statusCode).toBe(503);
      expect(err.channelId).toBe('UCabc');
      expect(err.message).toBe('fetch failed');
    });

    it('is an Error instance', () => {
      const err = new RssError('msg', 'UC123', 500);
      expect(err instanceof Error).toBe(true);
    });
  });
});

describe('RssFeedFetcher', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterAll(() => {
    db.close();
  });

  describe('fetch', () => {
    it('returns xml and status on successful fetch', async () => {
      const mockFetch = () => Promise.resolve({ xml: '<feed/>', status: 200 });
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch });

      const result = await fetcher.fetch('UC123');
      expect(result.xml).toBe('<feed/>');
      expect(result.status).toBe(200);
    });

    it('throws RssError immediately for non-transient 404', async () => {
      const mockFetch = () => Promise.reject(new RssError('Not found', 'UC123', 404));
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch });

      await expect(fetcher.fetch('UC123')).rejects.toBeInstanceOf(RssError);
      await expect(fetcher.fetch('UC123')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('retries on transient 503 error then succeeds', async () => {
      let calls = 0;
      const mockFetch = () => {
        if (++calls === 1) return Promise.reject(new RssError('Unavailable', 'UC123', 503));
        return Promise.resolve({ xml: '<feed/>', status: 200 });
      };
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch, maxRetries: 2 });

      const result = await fetcher.fetch('UC123');
      expect(result.xml).toBe('<feed/>');
      expect(calls).toBe(2);
    });

    it('throws after all retries exhausted on transient error', async () => {
      let callCount = 0;
      const mockFetch = () => {
        callCount++;
        return Promise.reject(new RssError('Unavailable', 'UC123', 503));
      };
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch, maxRetries: 2 });

      await expect(fetcher.fetch('UC123')).rejects.toBeInstanceOf(RssError);
      // initial + 2 retries = 3 calls
      expect(callCount).toBe(3);
    });

    it('resets backoff state on successful fetch', async () => {
      // Seed a backoff row with PAST time so isInBackoff returns false and fetch proceeds
      db.prepare(
        'INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code) VALUES (?, ?, ?, ?)'
      ).run('UC123', Date.now() - 1000, 5, 503);

      const mockFetch = () => Promise.resolve({ xml: '<feed/>', status: 200 });
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch });

      await fetcher.fetch('UC123');

      // Backoff row should be deleted after success
      const state = fetcher.getBackoffState('UC123');
      expect(state).toBeNull();
    });
  });

  describe('isInBackoff', () => {
    it('returns false when no backoff row exists', () => {
      const fetcher = new RssFeedFetcher(db);
      expect(fetcher.isInBackoff('UC123')).toBe(false);
    });

    it('returns true when backoff_until_ms is in the future', () => {
      db.prepare(
        'INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code) VALUES (?, ?, ?, ?)'
      ).run('UC123', Date.now() + 999999, 1, 503);

      const fetcher = new RssFeedFetcher(db);
      expect(fetcher.isInBackoff('UC123')).toBe(true);
    });

    it('returns false when backoff_until_ms has passed', () => {
      db.prepare(
        'INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code) VALUES (?, ?, ?, ?)'
      ).run('UC123', Date.now() - 1000, 1, 503);

      const fetcher = new RssFeedFetcher(db);
      expect(fetcher.isInBackoff('UC123')).toBe(false);
    });
  });

  describe('fetch with backoff check', () => {
    it('throws when channel is in active backoff', async () => {
      db.prepare(
        'INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code) VALUES (?, ?, ?, ?)'
      ).run('UC123', Date.now() + 999999, 1, 503);

      const fetcher = new RssFeedFetcher(db);
      await expect(fetcher.fetch('UC123')).rejects.toThrow('in backoff');
    });
  });

  describe('recordBackoff exponential growth', () => {
    it('records backoff with exponential growth on repeated transient errors', async () => {
      let calls = 0;
      const mockFetch = () => {
        calls++;
        return Promise.reject(new RssError('Unavailable', 'UC123', 503));
      };
      // maxRetries: 2 means initial + 2 retries = 3 attempts, each records backoff
      const fetcher = new RssFeedFetcher(db, { fetchWithStatus: mockFetch, maxRetries: 2 });

      try { await fetcher.fetch('UC123'); } catch {}

      const state = fetcher.getBackoffState('UC123');
      expect(state).not.toBeNull();
      // 3 failures recorded: backoff = 30s * 2^(3-1) = 120s
      expect(state!.consecutiveFailures).toBe(3);
      const backoffDuration = state!.backoffUntilMs - Date.now();
      expect(backoffDuration).toBeGreaterThan(90_000); // ~120s, allow timing slack
      expect(backoffDuration).toBeLessThan(150_000);
    });

    it('increases consecutive_failures on repeated transient errors', async () => {
      let calls = 0;
      const mockFetch = () => {
        calls++;
        return Promise.reject(new RssError('Unavailable', 'UC123', 503));
      };
      // First fetch — exhaust retries
      const fetcher1 = new RssFeedFetcher(db, { fetchWithStatus: mockFetch, maxRetries: 2 });
      try { await fetcher1.fetch('UC123'); } catch {}

      // Lower backoff so second attempt can run immediately
      db.prepare('UPDATE rss_backoff SET backoff_until_ms = 0').run();

      const fetcher2 = new RssFeedFetcher(db, { fetchWithStatus: mockFetch, maxRetries: 0 });
      try { await fetcher2.fetch('UC123'); } catch {}

      const state = fetcher2.getBackoffState('UC123');
      expect(state!.consecutiveFailures).toBeGreaterThan(1);
    });
  });

  describe('getBackoffState', () => {
    it('returns null when no backoff exists', () => {
      const fetcher = new RssFeedFetcher(db);
      expect(fetcher.getBackoffState('UC999')).toBeNull();
    });

    it('returns BackoffState row when backoff exists', () => {
      db.prepare(
        'INSERT INTO rss_backoff (channel_id, backoff_until_ms, consecutive_failures, last_status_code) VALUES (?, ?, ?, ?)'
      ).run('UC123', 1234567890, 3, 429);

      const fetcher = new RssFeedFetcher(db);
      const state = fetcher.getBackoffState('UC123');
      expect(state).toEqual({
        channelId: 'UC123',
        backoffUntilMs: 1234567890,
        consecutiveFailures: 3,
        lastStatusCode: 429,
      });
    });
  });
});
