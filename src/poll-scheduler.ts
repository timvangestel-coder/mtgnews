import Database from 'better-sqlite3';

export function enqueuePollRun(db: Database.Database, lookbackDays: number = 2): number {
  const stmt = db.prepare(
    'INSERT INTO poll_runs (triggered_at, status, new_signal_count, lookback_days) VALUES (?, ?, 0, ?)'
  );
  const result = stmt.run(Date.now(), 'running', lookbackDays);
  return Number(result.lastInsertRowid);
}
