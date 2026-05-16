import Database from 'better-sqlite3';

export function enqueuePollRun(db: Database.Database): number {
  const stmt = db.prepare(
    'INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, 0)'
  );
  const result = stmt.run(Date.now(), 'running');
  return Number(result.lastInsertRowid);
}