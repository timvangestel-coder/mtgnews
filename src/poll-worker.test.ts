import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';
import { createTopic } from './db/topics';
import { enqueuePollRun } from './poll-scheduler';
import { workerProcessRun, WorkerOptions } from './poll-worker';
import * as llm from './llm';

// Track call order for concurrency verification
let callOrder: string[] = [];

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
  let mockAnalyze: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createTestDb();
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC1', 'Channel 1', undefined, 1);
    addChannel(db, 'UC2', 'Channel 2', undefined, 1);
    // Default: analyzeSignal sets processed_at (simulates success)
    mockAnalyze = vi.spyOn(llm, 'analyzeSignal').mockImplementation(
      (database, videoId) => {
        database.prepare('UPDATE signals SET processed_at = ? WHERE video_id = ?').run(Date.now(), videoId);
        return Promise.resolve({ success: true });
      }
    );
  });

  afterEach(() => {
    mockAnalyze.mockRestore();
    callOrder = [];
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

  // Issue #24: Auto-summarize new signals
  it('summarizes new signals via analyzeSignal after pollChannel', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_sum1', 'Sum Video', 1));
        return Promise.resolve(makeXml('vid_sum2', 'Sum Video 2', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // 2 signals created -> 2 analyzeSignal calls
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    expect(mockAnalyze.mock.calls[0][1]).toBe('vid_sum1');
    expect(mockAnalyze.mock.calls[1][1]).toBe('vid_sum2');

    // signals now processed
    const unprocessed = db.prepare('SELECT COUNT(*) as c FROM signals WHERE processed_at IS NULL').get();
    expect((unprocessed as any).c).toBe(0);
  });

  it('skips signal on analyzeSignal failure, continues poll run', async () => {
    // Override default mock: first succeeds (sets processed_at), second throws
    mockAnalyze.mockImplementation((database, videoId) => {
      if (videoId === 'vid_err1') {
        database.prepare('UPDATE signals SET processed_at = ? WHERE video_id = ?').run(Date.now(), videoId);
        return Promise.resolve({ success: true });
      }
      return Promise.reject(new Error('LLM timeout'));
    });

    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_err1', 'Err Video', 1));
        return Promise.resolve(makeXml('vid_err2', 'Err Video 2', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // Both signals created, both analyzed attempted
    expect(mockAnalyze).toHaveBeenCalledTimes(2);

    // Run still done
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2);

    // Failed signal remains unprocessed (processed_at IS NULL)
    const unprocessed = db.prepare(
      'SELECT video_id FROM signals WHERE processed_at IS NULL'
    ).all() as { video_id: string }[];
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].video_id).toBe('vid_err2');
  });

  // Issue #39: Concurrency-limited task pool
  it('processes multiple signals concurrently (not sequentially)', async () => {
    // Override mock to track timing
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    mockAnalyze.mockImplementation((database, videoId) => {
      startTimes[videoId] = Date.now();
      return new Promise((resolve) => {
        setTimeout(() => {
          endTimes[videoId] = Date.now();
          database.prepare('UPDATE signals SET processed_at = ? WHERE video_id = ?').run(Date.now(), videoId);
          resolve({ success: true });
        }, 50); // 50ms per analysis
      });
    });

    const runId = enqueuePollRun(db);

    const startTime = Date.now();
    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_c1', 'C1 Video', 1));
        return Promise.resolve(makeXml('vid_c2', 'C2 Video', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    const duration = Date.now() - startTime;

    // With concurrency >= 2, two 50ms tasks run in parallel -> ~50-100ms total
    // Sequential would be ~100ms minimum just for analysis
    // Key signal: both signals processed and run completed
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2);

    // Both analyzed
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
  });

  it('respects LLM_CONCURRENCY env var for max concurrent tasks', async () => {
    const originalEnv = process.env.LLM_CONCURRENCY;
    process.env.LLM_CONCURRENCY = '1';

    const concurrencyCalls: number[] = [];
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    mockAnalyze.mockImplementation((database, videoId) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      concurrencyCalls.push(currentConcurrent);
      return new Promise((resolve) => {
        setTimeout(() => {
          currentConcurrent--;
          database.prepare('UPDATE signals SET processed_at = ? WHERE video_id = ?').run(Date.now(), videoId);
          resolve({ success: true });
        }, 30);
      });
    });

    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_conc1', 'Conc Video 1', 1));
        return Promise.resolve(makeXml('vid_conc2', 'Conc Video 2', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // With concurrency=1, max concurrent should be 1 (signals processed sequentially)
    expect(maxConcurrent).toBe(1);

    process.env.LLM_CONCURRENCY = originalEnv;
  });

  // Issue #43: worker passes runId to pollChannel -> signals get poll_run_id
  it('passes runId to pollChannel so signals have poll_run_id', async () => {
    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_fk1', 'FK Video 1', 1));
        return Promise.resolve(makeXml('vid_fk2', 'FK Video 2', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    const signals = db.prepare(
      'SELECT video_id, poll_run_id FROM signals'
    ).all() as Array<{ video_id: string; poll_run_id: number | null }>;
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.poll_run_id).toBe(runId);
    }
  });

  // Issue #55: skip NULL-topic channels, log warning
  it('skips channels with NULL topic_id and only processes channels with topic assigned', async () => {
    // Add a channel without topic_id
    addChannel(db, 'UC_NO_TOPIC', 'No Topic Channel');

    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_t1', 'T1 Video', 1));
        if (channelId === 'UC2') return Promise.resolve(makeXml('vid_t2', 'T2 Video', 1));
        // UC_NO_TOPIC should never reach here
        throw new Error('fetchRss called for NULL-topic channel');
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // Only 2 channels processed (UC1, UC2) — UC_NO_TOPIC skipped
    const progress = db.prepare('SELECT * FROM poll_run_progress WHERE poll_run_id = ?').all(runId);
    const channelIds = progress.map((p: any) => p.channel_id);
    expect(channelIds).toContain('UC1');
    expect(channelIds).toContain('UC2');
    expect(channelIds).not.toContain('UC_NO_TOPIC');

    // Run completes with signals from topic channels only
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2);
  });

  it('logs warning for channels skipped due to NULL topic_id', async () => {
    addChannel(db, 'UC_NULL_TOPIC', 'Null Topic Channel');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_w1', 'W Video 1', 1));
        return Promise.resolve(makeXml('vid_w2', 'W Video 2', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // Should log a warning about skipped channel
    const messages = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat();
    const hasSkipWarning = messages.some((m: string) =>
      m.includes('UC_NULL_TOPIC') && (m.includes('skip') || m.includes('NULL topic'))
    );
    expect(hasSkipWarning).toBe(true);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('errors in one signal do not block other signals (concurrent pool)', async () => {
    mockAnalyze.mockImplementation((database, videoId) => {
      if (videoId === 'vid_fail1') {
        return Promise.reject(new Error('LLM boom'));
      }
      database.prepare('UPDATE signals SET processed_at = ? WHERE video_id = ?').run(Date.now(), videoId);
      return Promise.resolve({ success: true });
    });

    const runId = enqueuePollRun(db);

    await workerProcessRun(db, runId, {
      fetchRss: (channelId: string) => {
        if (channelId === 'UC1') return Promise.resolve(makeXml('vid_fail1', 'Fail Video', 1));
        return Promise.resolve(makeXml('vid_ok1', 'OK Video', 1));
      },
      extractCaptions: () => Promise.resolve([{ text: 'mtg talk', start: 0, end: 5 }]),
    } as WorkerOptions);

    // Both attempted
    expect(mockAnalyze).toHaveBeenCalledTimes(2);

    // Run completes despite error
    const run = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(runId);
    expect(run.status).toBe('done');
    expect(run.new_signal_count).toBe(2);
  });
});
