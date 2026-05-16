import Database from 'better-sqlite3';

export interface PollRunRow {
  id: number;
  triggered_at: number;
  status: string;
  new_signal_count: number;
  completed_at: number | null;
  lookback_days: number;
  channels_total: number;
  channels_done: number;
  channels_failed: number;
}

export interface PollRunProgressRow {
  channel_id: string;
  display_name: string | null;
  status: string;
  signals_found: number;
  updated_at: number;
}

export interface PollRunsQuery {
  limit?: number;
  offset?: number;
}

export function queryPollRuns(db: Database.Database, query: PollRunsQuery = {}): { items: PollRunRow[]; total: number } {
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;

  const total = db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number };

  const items = db.prepare(
    `SELECT pr.id, pr.triggered_at, pr.status, pr.new_signal_count, pr.completed_at, pr.lookback_days,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id) as channels_total,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id AND prp.status = 'done') as channels_done,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id AND prp.status = 'failed') as channels_failed
     FROM poll_runs pr
     ORDER BY pr.triggered_at DESC
     LIMIT ? OFFSET ?`
  ).all(limit, offset) as PollRunRow[];

  return { items, total: total.c };
}

export function getPollRunById(db: Database.Database, id: number): PollRunRow | null {
  const row = db.prepare(
    `SELECT pr.id, pr.triggered_at, pr.status, pr.new_signal_count, pr.completed_at, pr.lookback_days,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id) as channels_total,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id AND prp.status = 'done') as channels_done,
      (SELECT COUNT(*) FROM poll_run_progress prp WHERE prp.poll_run_id = pr.id AND prp.status = 'failed') as channels_failed
     FROM poll_runs pr WHERE pr.id = ?`
  ).get(id);
  return row ? (row as PollRunRow) : null;
}

export function queryPollRunProgress(db: Database.Database, pollRunId: number): PollRunProgressRow[] {
  return db.prepare(
    `SELECT prp.channel_id, c.display_name, prp.status, prp.signals_found, prp.updated_at
     FROM poll_run_progress prp
     LEFT JOIN channels c ON c.channel_id = prp.channel_id
     WHERE prp.poll_run_id = ?
     ORDER BY prp.updated_at ASC`
  ).all(pollRunId) as PollRunProgressRow[];
}