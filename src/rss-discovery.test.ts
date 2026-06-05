import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRssFeed, parseChannelInfo, discoverCandidates, resolveChannelId, fetchChannelInfo, extractShortsVideoIds, RssCandidate, ChannelInfo } from './rss-discovery';
import { createTestDb } from '../tests/fixtures/test-db';

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
  describe('parseChannelInfo', () => {
    it('extracts display_name and avatar_url from RSS feed XML', () => {
      const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>MrBeast</title>
  <link rel="alternate" href="https://www.youtube.com/@MrBeast"/>
</feed>`;

      const result = parseChannelInfo(xml);
      expect(result).not.toBeNull();
      expect(result!.display_name).toBe('MrBeast');
      expect(result!.avatar_url).toBe('https://img.youtube.com/vi/placeholder/default.jpg');
    });

    it('returns null when title is missing', () => {
      const xml = `<feed><link rel="alternate" href="https://www.youtube.com/@Test"/></feed>`;
      expect(parseChannelInfo(xml)).toBeNull();
    });

    it('returns null when link is missing', () => {
      const xml = `<feed><title>Some Channel</title></feed>`;
      expect(parseChannelInfo(xml)).toBeNull();
    });
  });

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

    it('skips entries with /shorts/ in the link href', () => {
      const shortsXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:shortsvid1</id>
    <link href="https://www.youtube.com/shorts/shortsvid1"/>
    <title>A YouTube Short</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:shortsvid2</id>
    <link href="https://www.youtube.com/shorts/shortsvid2"/>
    <title>Another Short</title>
    <published>2026-05-09T08:30:00Z</published>
  </entry>
</feed>`;

      const result = parseRssFeed(shortsXml);
      expect(result).toHaveLength(0);
    });

    it('skips Shorts with real YouTube RSS link format (rel="alternate")', () => {
      const realShortsXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:qC1AWNt_DVI</id>
    <yt:videoId>qC1AWNt_DVI</yt:videoId>
    <yt:channelId>UCRvqjQPSeaWn-uEx-w0XOIg</yt:channelId>
    <title>It's Very Similar Once Again, Except...</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/qC1AWNt_DVI"/>
    <published>2026-06-04T17:25:43+00:00</published>
  </entry>
  <entry>
    <id>yt:video:regular_vid</id>
    <link rel="alternate" href="https://www.youtube.com/watch?v=regular_vid"/>
    <title>Regular Video</title>
    <published>2026-06-04T10:00:00+00:00</published>
  </entry>
</feed>`;

      const result = parseRssFeed(realShortsXml);
      expect(result).toHaveLength(1);
      expect(result[0].video_id).toBe('regular_vid');
    });

    it('returns only regular videos when feed has mixed Shorts and regular videos', () => {
      const mixedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:regular1</id>
    <link href="https://www.youtube.com/watch?v=regular1"/>
    <title>Regular Video</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:shortsvid</id>
    <link href="https://www.youtube.com/shorts/shortsvid"/>
    <title>A Short</title>
    <published>2026-05-10T11:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:regular2</id>
    <link href="https://www.youtube.com/watch?v=regular2"/>
    <title>Another Regular Video</title>
    <published>2026-05-10T10:00:00Z</published>
  </entry>
</feed>`;

      const result = parseRssFeed(mixedXml);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.video_id)).toContain('regular1');
      expect(result.map((r) => r.video_id)).toContain('regular2');
      expect(result.map((r) => r.video_id)).not.toContain('shortsvid');
    });
  });

  describe('extractShortsVideoIds', () => {
    it('returns video IDs for entries with /shorts/ in the link href', () => {
      const shortsXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:shortsvid1</id>
    <link href="https://www.youtube.com/shorts/shortsvid1"/>
    <title>A YouTube Short</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:shortsvid2</id>
    <link href="https://www.youtube.com/shorts/shortsvid2"/>
    <title>Another Short</title>
    <published>2026-05-09T08:30:00Z</published>
  </entry>
</feed>`;

      const result = extractShortsVideoIds(shortsXml);
      expect(result).toHaveLength(2);
      expect(result).toContain('shortsvid1');
      expect(result).toContain('shortsvid2');
    });

    it('returns empty array when feed has no Shorts', () => {
      const result = extractShortsVideoIds(SAMPLE_XML);
      expect(result).toHaveLength(0);
    });

    it('returns only Shorts IDs from a mixed feed', () => {
      const mixedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:regular1</id>
    <link href="https://www.youtube.com/watch?v=regular1"/>
    <title>Regular Video</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:shortsvid</id>
    <link href="https://www.youtube.com/shorts/shortsvid"/>
    <title>A Short</title>
    <published>2026-05-10T11:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:regular2</id>
    <link href="https://www.youtube.com/watch?v=regular2"/>
    <title>Another Regular Video</title>
    <published>2026-05-10T10:00:00Z</published>
  </entry>
</feed>`;

      const result = extractShortsVideoIds(mixedXml);
      expect(result).toHaveLength(1);
      expect(result).toContain('shortsvid');
    });

    it('returns empty array for feed with no entries', () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

      const result = extractShortsVideoIds(emptyXml);
      expect(result).toHaveLength(0);
    });

    it('extracts Shorts IDs with real YouTube RSS link format (rel="alternate")', () => {
      const realXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:qC1AWNt_DVI</id>
    <link rel="alternate" href="https://www.youtube.com/shorts/qC1AWNt_DVI"/>
    <title>A Short</title>
    <published>2026-06-04T17:25:43+00:00</published>
  </entry>
  <entry>
    <id>yt:video:regular_vid</id>
    <link rel="alternate" href="https://www.youtube.com/watch?v=regular_vid"/>
    <title>Regular Video</title>
    <published>2026-06-04T10:00:00+00:00</published>
  </entry>
</feed>`;

      const result = extractShortsVideoIds(realXml);
      expect(result).toHaveLength(1);
      expect(result).toContain('qC1AWNt_DVI');
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

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      expect(result.candidates).toHaveLength(2);
      expect(result.duplicateCount).toBe(0);
    });

    it('excludes video IDs already in signals table and reports duplicate count', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());
      db.prepare(
        'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
      ).run('dQw4w9WgXcQ', 'UC123', '[]', Date.now());

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      // dQw4w9WgXcQ already processed -> only abc123 remains
      const videoIds = result.candidates.map((c) => c.video_id);
      expect(videoIds).not.toContain('dQw4w9WgXcQ');
      expect(videoIds).toContain('abc123');
      expect(result.duplicateCount).toBe(1);
    });

    it('includes channel_id in each candidate', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      for (const c of result.candidates) {
        expect(c.channel_id).toBe('UC123');
      }
    });

    it('returns empty result when no channels provided', async () => {
      const result = await discoverCandidates(db, [], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.duplicateCount).toBe(0);
    });

    it('handles channel with no RSS feed gracefully without crashing', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC999', Date.now());

      const result = await discoverCandidates(db, ['UC999'], {
        fetchRss: () => Promise.reject(new Error('fetch failed')),
      });

      expect(result.candidates).toHaveLength(0);
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

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(xmlWithDates),
        lookbackDays: 2,
      });

      // Only recent_vid (1 day old) should pass; old_vid (10 days) should be filtered
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].video_id).toBe('recent_vid');
    });

    it('includes all candidates when lookbackDays is very large', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
        lookbackDays: 365,
      });

      expect(result.candidates).toHaveLength(2);
    });

    it('excludes all candidates when lookbackDays is 0', async () => {
      db.prepare('INSERT INTO channels (channel_id, added_at) VALUES (?, ?)').run('UC123', Date.now());

      const result = await discoverCandidates(db, ['UC123'], {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
        lookbackDays: 0,
      });

      expect(result.candidates).toHaveLength(0);
    });
  });

  describe('fetchChannelInfo', () => {
    it('returns channel info when RSS feed contains title and link', async () => {
      const rssXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Channel</title>
  <link rel="alternate" href="https://www.youtube.com/@TestChannel"/>
</feed>`;

      const result = await fetchChannelInfo('UC123', {
        fetchRss: () => Promise.resolve(rssXml),
      });

      expect(result).not.toBeNull();
      expect(result!.display_name).toBe('Test Channel');
    });

    it('returns null when RSS fetch fails', async () => {
      const result = await fetchChannelInfo('UC_INVALID', {
        fetchRss: () => Promise.reject(new Error('network error')),
      });

      expect(result).toBeNull();
    });

    it('returns null when RSS feed has no channel info', async () => {
      const rssXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>yt:video:abc</id><title>Video</title><published>2026-01-01T00:00:00Z</published></entry>
</feed>`;

      const result = await fetchChannelInfo('UC123', {
        fetchRss: () => Promise.resolve(rssXml),
      });

      expect(result).toBeNull();
    });
  });
});
