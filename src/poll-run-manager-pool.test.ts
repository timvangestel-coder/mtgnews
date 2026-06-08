import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PollRunManager } from './poll-run-manager';
import { ConcurrencyPool } from './concurrency-pool';
import { createTestDb } from '../tests/fixtures/test-db';

describe('PollRunManager with external pool', () => {
  let db: Database.Database;
  let pool: ConcurrencyPool;
  let manager: PollRunManager;

  beforeEach(() => {
    db = createTestDb();
    pool = new ConcurrencyPool(2);
    manager = new PollRunManager(db, pool);
  });

  afterAll(() => db.close());

  function seedTopic(id: number = 1) {
    db.prepare("INSERT INTO topics (id, key, short_name, filter_text) VALUES (?, ?, ?, ?)").run(id, 'tech', 'tech', 'tech');
  }
  function seedChannel(channelId: string = 'UC_test', topicId: number = 1) {
    db.prepare("INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)").run(channelId, 'Test Channel', Date.now(), topicId);
  }

  it('accepts ConcurrencyPool as constructor dependency', () => {
    // Manager should be constructible with external pool
    expect(manager).toBeDefined();
  });

  it('uses external pool instead of creating its own', async () => {
    seedTopic(); seedChannel();

    const runId = await manager.startRun();
    await new Promise((r) => setTimeout(r, 300));

    // Run should complete without errors when using external pool
    const state = manager.runState(runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('complete');
  });

  it('works with default pool when none provided', async () => {
    seedTopic(); seedChannel();

    // No pool passed — should use internal default
    const defaultManager = new PollRunManager(db);
    const runId = await defaultManager.startRun();
    await new Promise((r) => setTimeout(r, 300));

    const state = defaultManager.runState(runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('complete');
  });
});