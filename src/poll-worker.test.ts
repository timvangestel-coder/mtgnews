import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { enqueuePollRun } from './poll-scheduler';
import { workerProcessRun, WorkerOptions } from './poll-worker';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

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

describe('poll-worker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UC1', 'Channel 1');
    addChannel(db, 'UC2', 'Channel 2');
  });

  afterAll(() => {
    db.close();
  });

  it('processes channels sequentially and updates poll_run to done', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_uc1', 'UC1 Video', 1));
        return Promise.resolve(makeXml('vid_uc2', 'UC2 Video', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'hello', start: 0, end: 2 }]),
    } as WorkerOptions);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.completed_at).toBeTypeOf('number');
    expect(run.new_signal_count).toBe(2); // 1 from UC1 + 1 from UC2
  });

  it('creates poll_run_progress row per channel', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_uc1', 'UC1 Video', 1));
        return Promise.resolve(makeXml('vid_uc2', 'UC2 Video', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    } as WorkerOptions);

    const progress = db.prepare('SELECT * FROM poll_run_progress WHERE poll_run_id = ?').all(runId);
    expect(progress).toHaveLength(2);

    const uc1 = progress.find((p: any) => p.channel_id === 'UC1');
    expect(uc1.status).toBe('done');
    expect(uc1.signals_found).toBe(1);

    const uc2 = progress.find((p: any) => p.channel_id === 'UC2');
    expect(uc2.status).toBe('done');
    expect(uc2.signals_found).toBe(1);
  });

  it('continues to next channel when one fails', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') throw new Error('RSS fetch failed');
        return Promise.resolve(makeXml('vid_uc2', 'UC2 Video', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'x', start: 0, end: 1 }]),
    } as WorkerOptions);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done'); // run completes even if channel fails

    const progress = db.prepare('SELECT * FROM poll_run_progress WHERE poll_run_id = ?').all(runId);
    const uc1 = progress.find((p: any) => p.channel_id === 'UC1');
    expect(uc1.status).toBe('failed');

    const uc2 = progress.find((p: any) => p.channel_id === 'UC2');
    expect(uc2.status).toBe('done');
    expect(run.new_signal_count).toBe(1); // only UC2 contributed
  });

  it('marks run as done when no channels exist', async () => {
    db.prepare('DELETE FROM channels').run();
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {} as WorkerOptions);

    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(0);
  });
});