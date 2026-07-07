import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addChannel, createTopic } from './db/watchlist';
import { PollRunManager } from './poll-run-manager';
import * as llm from './llm';
import * as pollMod from './poll';
import { createTestDb } from '../tests/fixtures/test-db';

function makeXml(videoId: string, title: string, daysAgo: number) {
  const published = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:${videoId}</id>
    <link href="https://www.youtube.com/watch?v=${videoId}"/>
    <title>${title}</title>
    <published>${published}</published>
  </entry>
</feed>`;
}

function makeXmlMulti(entries: Array<{ videoId: string; title: string; daysAgo: number }>) {
  const entryXml = entries.map(e => {
    const published = new Date(Date.now() - e.daysAgo * 24 * 60 * 60 * 1000).toISOString();
    return `  <entry>
    <id>yt:video:${e.videoId}</id>
    <link href="https://www.youtube.com/watch?v=${e.videoId}"/>
    <title>${e.title}</title>
    <published>${published}</published>
  </entry>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
${entryXml}
</feed>`;
}

describe('poll integration: full multi-channel cycle via PollRunManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Disable inter-request delay in tests for speed
    process.env.POLL_REQUEST_DELAY_MS = '0';
    db = createTestDb();
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC_A', 'Channel A', undefined, 1);
    addChannel(db, 'UC_B', 'Channel B', undefined, 1);
    vi.spyOn(llm, 'analyzeSignal').mockImplementation(async (database, videoId) => {
      database.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('summarized', videoId);
      return { success: true };
    });
  });

  afterEach(() => {
    delete process.env.POLL_REQUEST_DELAY_MS;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    db.close();
  });

  it('startRun -> worker -> done with progress rows and signals persisted', async () => {
    // Mock pollChannel to return controlled results
    const mockPollChannel = vi.spyOn(pollMod, 'pollChannel').mockImplementation(async (database, channelId) => {
      if (channelId === 'UC_A') {
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('v1', channelId, 'Ch1 Video', new Date().toISOString(), '', Date.now(), 1);
        return { newSignals: 1, skippedDuplicates: 0, skippedNoCaptions: [] };
      }
      if (channelId === 'UC_B') {
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('v2', channelId, 'Ch2 Video', new Date().toISOString(), '', Date.now(), 1);
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('v3', channelId, 'Ch2 Video 2', new Date().toISOString(), '', Date.now(), 1);
        return { newSignals: 2, skippedDuplicates: 0, skippedNoCaptions: [] };
      }
      return { newSignals: 0, skippedDuplicates: 0, skippedNoCaptions: [] };
    });

    const manager = new PollRunManager(db);
    const runId = await manager.startRun();
    expect(runId).toBeGreaterThan(0);

    // Wait for worker to complete
    await new Promise((r) => setTimeout(r, 500));

    // verify run status via RunState
    const state = manager.runState(runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('complete');
    // newSignalCount is on the DB row, not in RunState (removed in issue #79)
    const runRow = db.prepare('SELECT new_signal_count FROM poll_runs WHERE id = ?').get(runId) as { new_signal_count: number };
    expect(runRow.new_signal_count).toBe(3); // 1 from A + 2 from B

    // verify progress rows
    const progress = db.prepare(
      'SELECT channel_id, status, signals_found FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id'
    ).all(runId);
    expect(progress).toHaveLength(2);

    expect((progress[0] as any).channel_id).toBe('UC_A');
    expect((progress[0] as any).status).toBe('done');
    expect((progress[0] as any).signals_found).toBe(1);

    expect((progress[1] as any).channel_id).toBe('UC_B');
    expect((progress[1] as any).status).toBe('done');
    expect((progress[1] as any).signals_found).toBe(2);

    // verify signals persisted
    const signals = db.prepare('SELECT video_id, channel_id FROM signals ORDER BY video_id').all();
    expect(signals).toHaveLength(3);
    expect((signals[0] as any).video_id).toBe('v1');
    expect((signals[0] as any).channel_id).toBe('UC_A');

    mockPollChannel.mockRestore();
  });

  it('failed channel does not abort run, progress reflects failure', async () => {
    const mockPollChannel = vi.spyOn(pollMod, 'pollChannel').mockImplementation(async (database, channelId) => {
      if (channelId === 'UC_A') throw new Error('network error');
      if (channelId === 'UC_B') {
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('v2', channelId, 'Ch2 Video', new Date().toISOString(), '', Date.now(), 1);
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('v3', channelId, 'Ch2 Video 2', new Date().toISOString(), '', Date.now(), 1);
        return { newSignals: 2, skippedDuplicates: 0, skippedNoCaptions: [] };
      }
      return { newSignals: 0, skippedDuplicates: 0, skippedNoCaptions: [] };
    });

    const manager = new PollRunManager(db);
    const runId = await manager.startRun();

    // Wait for worker to complete
    await new Promise((r) => setTimeout(r, 500));

    const state = manager.runState(runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('complete');
    const runRow2 = db.prepare('SELECT new_signal_count FROM poll_runs WHERE id = ?').get(runId) as { new_signal_count: number };
    expect(runRow2.new_signal_count).toBe(2); // only UC_B

    const progress = db.prepare(
      'SELECT channel_id, status FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id'
    ).all(runId);

    expect((progress[0] as any).channel_id).toBe('UC_A');
    expect((progress[0] as any).status).toBe('failed');

    expect((progress[1] as any).channel_id).toBe('UC_B');
    expect((progress[1] as any).status).toBe('done');

    mockPollChannel.mockRestore();
  });
});