import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from './db/init-db';

vi.mock('./llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm')>();
  return {
    ...actual,
    analyzeSignal: vi.fn().mockRejectedValue(new Error('LLM endpoint unreachable')),
    getLlmConfig: actual.getLlmConfig,
  };
});

vi.mock('./poll', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./poll')>();
  return {
    ...actual,
    pollChannel: vi.fn().mockImplementation(async (database, channelId, options?: any) => {
      if (channelId === 'UC_fail') {
        const runId = options?.runId;
        database.prepare(
          "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run('fail_vid1', channelId, 'Fail Video', new Date().toISOString(), JSON.stringify([{ start: 0, text: 'test' }]), Date.now(), runId);
        return { newSignals: 1, skippedDuplicates: 0, skippedNoCaptions: [] };
      }
      return { newSignals: 0, skippedDuplicates: 0, skippedNoCaptions: [] };
    }),
  };
});

// Re-import after mocking so mocked dependencies are used
const { PollRunManager } = await import('./poll-run-manager');

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('done counter incremented on analysis failure', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('increments done counter even when analyzeSignal throws', async () => {
    // Add a topic and channel
    db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(1, 'tech', 'Tech', 'technology');
    db.prepare(
      "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
    ).run('UC_fail', 'Fail Channel', Date.now(), 1);

    const failManager = new PollRunManager(db);
    const runId = await failManager.startRun();

    // Wait for worker to complete (including failed analysis)
    await new Promise((r) => setTimeout(r, 500));

    const state = failManager.runState(runId);
    expect(state).not.toBeNull();
    // Channel had 1 signal discovered → total=1
    expect(state!.steps[0].total).toBe(1);
    // Even though analysis failed, done counter was incremented
    expect(state!.steps[0].done).toBe(1);
  });
});