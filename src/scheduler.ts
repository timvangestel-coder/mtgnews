import cron from 'node-cron';
import Database from 'better-sqlite3';
import { enqueuePollRun } from './poll-scheduler';

let _db: Database.Database | null = null;
let _disposable: cron.ScheduledTask | null = null;

/**
 * Start daily scheduled polling at midnight UTC.
 * Enqueues a PollRun row via the same path as manual trigger.
 */
export function startScheduledPolling(database: Database.Database): void {
  _db = database;
  _disposable = cron.schedule('0 0 * * *', () => {
    if (_db) {
      enqueuePollRun(_db, 2);
    }
  });
}

/**
 * Stop the scheduled polling job.
 */
export function stopScheduledPolling(): void {
  if (_disposable) {
    _disposable.stop();
    _disposable = null;
  }
  _db = null;
}