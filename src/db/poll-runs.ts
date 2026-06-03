import Database from 'better-sqlite3';

/** Insert pending progress rows for all active channels with a topic_id, so the UI can show them immediately. */
export function preRegisterChannelProgress(db: Database.Database, pollRunId: number): void {
  const channels = db.prepare(
    `SELECT c.channel_id FROM channels c WHERE c.active = 1 AND c.topic_id IS NOT NULL`
  ).all() as Array<{ channel_id: string }>;

  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
  );

  const txn = db.transaction((runId: number, rows: typeof channels) => {
    for (const ch of rows) {
      insert.run(runId, ch.channel_id, 'pending', 0, now);
    }
  });

  txn(pollRunId, channels);
}

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
  signalsDone: number;
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
  const rows = db.prepare(
    `SELECT prp.channel_id, c.display_name, prp.status, prp.signals_found, COALESCE(prp.signals_done, 0) as signalsDone, prp.updated_at
      FROM poll_run_progress prp
      LEFT JOIN channels c ON c.channel_id = prp.channel_id
      WHERE prp.poll_run_id = ?
      ORDER BY prp.updated_at ASC`
  ).all(pollRunId) as Array<{
    channel_id: string;
    display_name: string | null;
    status: string;
    signals_found: number;
    signalsDone: number;
    updated_at: number;
  }>;

  // Map snake_case to camelCase for TypeScript interface compatibility
  return rows.map((r) => ({
    channel_id: r.channel_id,
    display_name: r.display_name,
    status: r.status,
    signals_found: r.signals_found,
    signalsDone: r.signalsDone,
    updated_at: r.updated_at,
  }));
}
