import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addChannel } from './db/watchlist';
import { RssCandidate } from './rss-discovery';
import { TranscriptionSegment } from './transcription';
import { ingestSignal, IngestResult, pollChannel } from './poll';
import { createTestDb } from '../tests/fixtures/test-db';

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

describe('ingestSignal', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UCtest', 'Test Channel');
  });

  afterAll(() => {
    db.close();
  });

  it('ingests a new candidate and persists the signal', async () => {
    const candidate: RssCandidate = {
      video_id: 'vid1',
      channel_id: 'UCtest',
      title: 'Test Video',
      published_at: '2026-05-10T12:00:00Z',
    };

    const result: IngestResult = await ingestSignal(db, candidate, {
      extractCaptions: () =>
        Promise.resolve([
          { text: 'hello world', start: 0, end: 5000 },
        ]),
    });

    expect(result.ingested).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.noCaptions).toBe(false);

    const signals = db.prepare('SELECT video_id, title, transcription FROM signals').all();
    expect(signals).toHaveLength(1);
    expect(signals[0].video_id).toBe('vid1');
    expect(signals[0].title).toBe('Test Video');
  });

  it('returns duplicate when video already exists in signals', async () => {
    // Pre-insert the video
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
    ).run('vid1', 'UCtest', '[]', Date.now());

    const candidate: RssCandidate = {
      video_id: 'vid1',
      channel_id: 'UCtest',
      title: 'Test Video',
      published_at: '2026-05-10T12:00:00Z',
    };

    const result: IngestResult = await ingestSignal(db, candidate, {
      extractCaptions: () => Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    });

    expect(result.duplicate).toBe(true);
    expect(result.ingested).toBe(false);
    expect(result.noCaptions).toBe(false);

    // No new signal inserted — still just the original
    const signals = db.prepare('SELECT video_id FROM signals').all();
    expect(signals).toHaveLength(1);
  });

  it('returns noCaptions when extraction returns empty segments', async () => {
    const candidate: RssCandidate = {
      video_id: 'vid1',
      channel_id: 'UCtest',
      title: 'Test Video',
      published_at: '2026-05-10T12:00:00Z',
    };

    const result: IngestResult = await ingestSignal(db, candidate, {
      extractCaptions: () => Promise.resolve([]),
    });

    expect(result.noCaptions).toBe(true);
    expect(result.ingested).toBe(false);
    expect(result.duplicate).toBe(false);

    // No signal persisted
    const signals = db.prepare('SELECT video_id FROM signals').all();
    expect(signals).toHaveLength(0);
  });

  it('returns noCaptions when extraction throws an error', async () => {
    const candidate: RssCandidate = {
      video_id: 'vid1',
      channel_id: 'UCtest',
      title: 'Test Video',
      published_at: '2026-05-10T12:00:00Z',
    };

    const result: IngestResult = await ingestSignal(db, candidate, {
      extractCaptions: () => Promise.reject(new Error('yt-dlp failed')),
    });

    expect(result.noCaptions).toBe(true);
    expect(result.ingested).toBe(false);
    expect(result.duplicate).toBe(false);

    // No signal persisted, no crash
    const signals = db.prepare('SELECT video_id FROM signals').all();
    expect(signals).toHaveLength(0);
  });

  it('persists poll_run_id when runId provided', async () => {
    // Create a poll_run row so FK constraint passes
    const runResult = db.prepare(
      'INSERT INTO poll_runs (triggered_at, status, lookback_days) VALUES (?, ?, ?)'
    ).run(Date.now(), 'running', 2);
    const runId = Number(runResult.lastInsertRowid);

    const candidate: RssCandidate = {
      video_id: 'vid1',
      channel_id: 'UCtest',
      title: 'Test Video',
      published_at: '2026-05-10T12:00:00Z',
    };

    const result: IngestResult = await ingestSignal(db, candidate, {
      extractCaptions: () => Promise.resolve([{ text: 'hello', start: 0, end: 5000 }]),
      runId,
    });

    expect(result.ingested).toBe(true);

    const signal = db.prepare('SELECT poll_run_id FROM signals WHERE video_id = ?').get('vid1') as { poll_run_id: number | null };
    expect(signal.poll_run_id).toBe(runId);
  });
});

describe('poll', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UCtest', 'Test Channel');
  });

  afterAll(() => {
    db.close();
  });

  it('runs full poll cycle: discover -> transcribe -> group -> persist', async () => {
    const result = await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: () =>
        Promise.resolve([
          { text: 'hello', start: 0, end: 2000 },
          { text: 'world', start: 2000, end: 4000 },
        ]),
    });

    expect(result.newSignals).toBe(2);

    // verify signals persisted with grouped transcription shape
    const signals = db.prepare('SELECT video_id, transcription FROM signals').all();
    expect(signals).toHaveLength(2);

    // transcription should be grouped [{time, text}] not raw segments
    const vid1 = signals.find((s: any) => s.video_id === 'vid1');
    const trans1 = JSON.parse(vid1!.transcription);
    expect(trans1).toHaveLength(1);
    expect(trans1[0]).toHaveProperty('time');
    expect(trans1[0]).toHaveProperty('text');
    expect(trans1[0].text).toBe('hello world');
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

  // Issue #43: pollChannel accepts runId, persists it on signals
  it('persists poll_run_id on signals when runId provided', async () => {
    // Create a poll_run row so FK constraint passes
    const result = db.prepare(
      'INSERT INTO poll_runs (triggered_at, status, lookback_days) VALUES (?, ?, ?)'
    ).run(Date.now(), 'running', 2);
    const runId = Number(result.lastInsertRowid);

    const pollResult = await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: () =>
        Promise.resolve([
          { text: 'hello', start: 0, end: 2000 },
          { text: 'world', start: 2000, end: 4000 },
        ]),
      runId,
    });

    expect(pollResult.newSignals).toBe(2);

    const signals = db.prepare('SELECT video_id, poll_run_id FROM signals').all() as Array<{ video_id: string; poll_run_id: number | null }>;
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.poll_run_id).toBe(runId);
    }
  });

  it('signals have poll_run_id NULL when runId not provided', async () => {
    await pollChannel(db, 'UCtest', {
      fetchRss: () => Promise.resolve(SAMPLE_XML),
      extractCaptions: () =>
        Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    });

    const signals = db.prepare('SELECT poll_run_id FROM signals').all() as Array<{ poll_run_id: number | null }>;
    for (const s of signals) {
      expect(s.poll_run_id).toBeNull();
    }
  });

  // Issue #61: pollChannel should NOT fetch RSS a second time for duplicate counting
  it('counts duplicates without a second RSS fetch', async () => {
    let rssFetchCount = 0;
    const fetchRss = () => {
      rssFetchCount++;
      return Promise.resolve(SAMPLE_XML);
    };

    // Pre-insert vid1 so it's a duplicate
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
    ).run('vid1', 'UCtest', '[]', Date.now());

    await pollChannel(db, 'UCtest', {
      fetchRss,
      extractCaptions: () => Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    });

    // RSS should only be fetched ONCE (by discoverCandidates), not twice
    expect(rssFetchCount).toBe(1);
  });
});
