import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { RssCandidate } from './rss-discovery';
import { TranscriptionSegment } from './transcription';
import { pollChannel } from './poll';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:vid1</id>
    <link href="https://www.youtube.com/watch?v=vid1"/>
    <title>MTG Set Review</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:vid2</id>
    <link href="https://www.youtube.com/watch?v=vid2"/>
    <title>Meta Update</title>
    <published>2026-05-11T08:00:00Z</published>
  </entry>
</feed>`;

describe('poll', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UCtest', 'Test Channel');
  });

  afterAll(() => {
    db.close();
  });

  it('runs full poll cycle: discover -> transcribe -> persist', async () => {
    const result = await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: () =>
        Promise.resolve([
          { text: 'hello', start: 0, end: 2 },
        ]),
    });

    expect(result.newSignals).toBe(2);

    // verify signals persisted
    const signals = db.prepare('SELECT video_id, channel_id, title FROM signals').all();
    expect(signals).toHaveLength(2);

    const vid1 = signals.find((s: any) => s.video_id === 'vid1');
    expect(vid1!.channel_id).toBe('UCtest');
    expect(vid1!.title).toBe('MTG Set Review');
  });

  it('skips duplicate video_ids already in signals', async () => {
    // pre-insert vid1
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
    ).run('vid1', 'UCtest', '[]', Date.now());

    const result = await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: () =>
        Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    });

    expect(result.newSignals).toBe(1);
    expect(result.skippedDuplicates).toBe(1);

    const signals = db.prepare('SELECT video_id FROM signals').all();
    expect(signals).toHaveLength(2); // pre-existing vid1 + new vid2
  });

  it('skips videos with no captions and logs them', async () => {
    const result = await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: (videoId: string) => {
        if (videoId === 'vid1') return Promise.resolve([]);
        return Promise.resolve([{ text: 'has caps', start: 0, end: 1 }]);
      },
    });

    expect(result.newSignals).toBe(1);
    expect(result.skippedNoCaptions).toContain('vid1');

    // only vid2 persisted
    const signals = db.prepare('SELECT video_id FROM signals').all();
    expect(signals).toHaveLength(1);
    expect(signals[0].video_id).toBe('vid2');
  });

  it('throws when channel not in watchlist', async () => {
    await expect(
      pollChannel(db, 'UCunknown', {
        fetchRss: () => Promise.resolve(SAMPLE_XML),
        extractCaptions: () => Promise.resolve([]),
      })
    ).rejects.toThrow();
  });
});