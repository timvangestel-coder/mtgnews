import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { enqueuePollRun } from './poll-scheduler';
import { workerProcessRun } from './poll-worker';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

const XML1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:v1</id>
    <link href="https://www.youtube.com/watch?v=v1"/>
    <title>Ch1 Video</title>
    <published>2026-05-10T12:00:00Z</published>
  </entry>
</feed>`;

const XML2 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>yt:video:v2</id>
    <link href="https://www.youtube.com/watch?v=v2"/>
    <title>Ch2 Video</title>
    <published>2026-05-11T12:00:00Z</published>
  </entry>
  <entry>
    <id>yt:video:v3</id>
    <link href="https://www.youtube.com/watch?v=v3"/>
    <title>Ch2 Video 2</title>
    <published>2026-05-12T12:00:00Z</published>
  </entry>
</feed>`;

describe('poll integration: full multi-channel cycle', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UC_A', 'Channel A');
    addChannel(db, 'UC_B', 'Channel B');
  });

  afterAll(() => {
    db.close();
  });

  it('enqueue -> worker -> done with progress rows and signals persisted', async () => {
    // enqueue
    const runId = enqueuePollRun(db);

    const runBefore = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(runBefore.status).toBe('running');
    expect(runBefore.completed_at).toBeNull();

    // worker processes
    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC_A') return Promise.resolve(XML1);
        if (channelId === 'UC_B') return Promise.resolve(XML2);
        return Promise.resolve('');
      },
      extractCaptions: () => Promise.resolve([{ text: 'seg', start: 0, end: 5 }]),
    });

    // verify run status
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.completed_at).toBeTypeOf('number');
    expect(run.new_signal_count).toBe(3); // 1 from A + 2 from B

    // verify progress rows
    const progress = db.prepare(
      'SELECT channel_id, status, signals_found FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id'
    ).all(runId);
    expect(progress).toHaveLength(2);

    expect(progress[0].channel_id).toBe('UC_A');
    expect(progress[0].status).toBe('done');
    expect(progress[0].signals_found).toBe(1);

    expect(progress[1].channel_id).toBe('UC_B');
    expect(progress[1].status).toBe('done');
    expect(progress[1].signals_found).toBe(2);

    // verify signals persisted
    const signals = db.prepare('SELECT video_id, channel_id FROM signals ORDER BY video_id').all();
    expect(signals).toHaveLength(3);
    expect(signals[0].video_id).toBe('v1');
    expect(signals[0].channel_id).toBe('UC_A');
    expect(signals[1].video_id).toBe('v2');
    expect(signals[1].channel_id).toBe('UC_B');
    expect(signals[2].video_id).toBe('v3');
    expect(signals[2].channel_id).toBe('UC_B');
  });

  it('failed channel does not abort run, progress reflects failure', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC_A') throw new Error('network error');
        return Promise.resolve(XML2);
      },
      extractCaptions: () => Promise.resolve([{ text: 'seg', start: 0, end: 5 }]),
    });

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2); // only UC_B

    const progress = db.prepare(
      'SELECT channel_id, status FROM poll_run_progress WHERE poll_run_id = ? ORDER BY channel_id'
    ).all(runId);

    expect(progress[0].channel_id).toBe('UC_A');
    expect(progress[0].status).toBe('failed');

    expect(progress[1].channel_id).toBe('UC_B');
    expect(progress[1].status).toBe('done');
  });
});