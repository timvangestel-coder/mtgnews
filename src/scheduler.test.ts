import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
import { startScheduledPolling, stopScheduledPolling } from './scheduler';

// vi.mock hoists to top -> define mock fn inside factory
vi.mock('node-cron', () => {
  const mockSchedule = vi.fn((_, fn) => {
    (global as any).__mockCronFn = fn;
    return { stop: vi.fn() };
  });
  return {
    default: {
      schedule: mockSchedule,
    },
  };
});

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('scheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterAll(() => {
    stopScheduledPolling();
    db.close();
  });

  it('starts cron job that enqueues poll runs', () => {
    startScheduledPolling(db);

    const cronFn = (global as any).__mockCronFn;
    expect(cronFn).toBeDefined();
    cronFn();

    const runs = db.prepare('SELECT * FROM poll_runs').all();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
  });

  it('calls cron.schedule on start', () => {
    startScheduledPolling(db);
    const cronFn = (global as any).__mockCronFn;
    expect(cronFn).toBeTypeOf('function');
  });
});