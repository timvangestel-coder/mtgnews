import Database from 'better-sqlite3';
import { listActiveChannels } from './db/watchlist';
import { pollChannel, PollOptions } from './poll';

export interface WorkerOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  extractCaptions?: (videoId: string) => Promise<Array<{ text: string; start: number; end: number }>>;
}

export async function workerProcessRun(
  db: Database.Database,
  runId: number,
  options: WorkerOptions = {}
): Promise<void> {
  const channels = listActiveChannels(db);
  let totalNewSignals = 0;

  for (const channel of channels) {
    try {
      const result = await pollChannel(db, channel.channel_id, {
        fetchRss: options.fetchRss,
        extractCaptions: options.extractCaptions,
      } as PollOptions);

      totalNewSignals += result.newSignals;

      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, channel.channel_id, 'done', result.newSignals, Date.now());
    } catch (err) {
      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, channel.channel_id, 'failed', 0, Date.now());
      // continue to next channel
    }
  }

  db.prepare(
    'UPDATE poll_runs SET status = ?, new_signal_count = ?, completed_at = ? WHERE id = ?'
  ).run('done', totalNewSignals, Date.now(), runId);
}