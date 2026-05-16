import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { parseRssFeed, discoverCandidates, resolveChannelId, RssCandidate } from './rss-discovery';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id>
    <link href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <title>Test Video Title</title>
    <published>2026-05-10T12:00:00Z</published>
    <media:thumbnail url="https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg"/>
  </entry>
  <entry>
    <id>yt:video:abc123</id>
    <link href="https://www.youtube.com/watch?v=abc123"/>
    <title>Another Video</title>
    <published>2026-05-09T08:30:00Z</published>
    <media:thumbnail url="https://i.ytimg.com/vi/abc123/default.jpg"/>
  </entry>
</feed>`;

describe('rss-discovery', () => {
  describe('parseRssFeed', () => {
    it('extracts video_id, title, and published_at from each entry', () => {
      const result = parseRssFeed(SAMPLE_XML);

      expect(result).toHaveLength(2);

      const first = result[0];
      expect(first.video_id).toBe('dQw4w9WgXcQ');
      expect(first.title).toBe('Test Video Title');
      expect(first.published_at).toBe('2026-05-10T12:00:00Z');

      const second = result[1];
      expect(second.video_id).toBe('abc123');
      expect(second.title).toBe('Another Video');
      expect(second.published_at).toBe('2026-05-09T08:30:00Z');
    });

    it('returns empty array for XML with no entries', () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

      const result = parseRssFeed(emptyXml);
      expect(result).toHaveLength(0);
    });

    it('throws for malformed XML', () => {
      expect(() => parseRssFeed('not xml at all <><>')).toThrow();
    });
  });

  describe('resolveChannelId', () => {
    it('returns raw UC ID as-is', async () => {
      const result = await resolveChannelId('UCaBcDeFgHiJkLmNoPqRsTuVw');
      expect(result).toBe('UCaBcDeFgHiJkLmNoPqRsTuVw');
    });

    it('extracts UC ID from /channel/UC... URL', async () => {
      const result = await resolveChannelId(
        'https://www.youtube.com/channel/UCaBcDeFgHiJkLmNoPqRsTuVw'
      );
      expect(result).toBe('UCaBcDeFgHiJkLmNoPqRsTuVw');
    });

    it('resolves @handle by fetching page HTML', async () => {
      const mockHtml = `
        <script>var ytInitialData = {
          "header": {
            "c4TabbedHeaderRenderer": {
              "channelId": "UCTp-iVOtTrKau0skmfZlo5Q"
            }
          }
        };</script>
      `;

      const result = await resolveChannelId('https://www.youtube.com/@SomeChannel', {
        fetchPage: (url) => Promise.resolve(mockHtml),
      });
      expect(result).toBe('UCTp-iVOtTrKau0skmfZlo5Q');
    });

    it('resolves bare @handle', async () => {
      const mockHtml = `
        "browseId":"UCabcDEF1234567890abcd"
      `;

      const result = await resolveChannelId('@BareHandle', {
        fetchPage: (url) => Promise.resolve(mockHtml),
      });
      expect(result).toBe('UCabcDEF1234567890abcd');
    });

    it('throws on missing browseId in page HTML', async () => {
      await expect(
        resolveChannelId('@NoIdChannel', {
          fetchPage: (url) => Promise.resolve('<html><body>No channel data</body></html>'),
        })
      ).rejects.toThrow();
    });
  });

  describe('discoverCandidates', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = createTestDb();
    });

    afterAll(() => {
      db.close();
    });

    it('returns candidates for channels with no existing signals', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      expect(candidates).toHaveLength(2);
    });

    it('excludes video IDs already in signals table', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());
      db.prepare(
        'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
      ).run('dQw4w9WgXcQ', 'UC123', '[]', Date.now());

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      // dQw4w9WgXcQ already processed -> only abc123 remains
      const videoIds = candidates.map((c) => c.video_id);
      expect(videoIds).not.toContain('dQw4w9WgXcQ');
      expect(videoIds).toContain('abc123');
    });

    it('includes channel_id in each candidate', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      for (const c of candidates) {
        expect(c.channel_id).toBe('UC123');
      }
    });

    it('returns empty array when no channels provided', async () => {
      const candidates = await discoverCandidates(db, [], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      expect(candidates).toHaveLength(0);
    });

    it('handles channel with no RSS feed gracefully without crashing', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC999', Date.now());

      const candidates = await discoverCandidates(db, ['UC999'], {
        fetchRss: () => Promise.reject(new Error('fetch failed')),
      });

      expect(candidates).toEqual([]);
    });

    it('filters out candidates older than lookback_days', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      // Build XML with entries at different dates relative to "now"
      const now = Date.now();
      const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      const old = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

      const xmlWithDates = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:recent_vid</id>
    <link href="https://www.youtube.com/watch?v=recent_vid"/>
    <title>Recent Video</title>
    <published>${recent}</published>
  </entry>
  <entry>
    <id>yt:video:old_vid</id>
    <link href="https://www.youtube.com/watch?v=old_vid"/>
    <title>Old Video</title>
    <published>${old}</published>
  </entry>
</feed>`;

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(xmlWithDates),
        lookbackDays: 2,
      });

      // Only recent_vid (1 day old) should pass; old_vid (10 days) should be filtered
      expect(candidates).toHaveLength(1);
      expect(candidates[0].video_id).toBe('recent_vid');
    });

    it('includes all candidates when lookbackDays is very large', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
        lookbackDays: 365,
      });

      expect(candidates).toHaveLength(2);
    });

    it('excludes all candidates when lookbackDays is 0', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const candidates = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
        lookbackDays: 0,
      });

      expect(candidates).toHaveLength(0);
    });
  });
});
