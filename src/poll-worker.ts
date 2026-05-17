import Database from 'better-sqlite3';
import { listActiveChannels } from './db/watchlist';
import { pollChannel, PollOptions } from './poll';
import { analyzeSignal, getLlmConfig } from './llm';

export interface WorkerOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  extractCaptions?: (videoId: string) => Promise<Array<{ text: string; start: number; end: number }>>;
}

export async function workerProcessRun(
  db: Database.Database,
  runId: number,
  options: WorkerOptions = {}
): Promise<void> {
  // read lookback_days from poll_runs row (defaults to 2 via DB column default)
  const runRow = db.prepare(
    'SELECT lookback_days FROM poll_runs WHERE id = ?'
  ).get(runId) as { lookback_days: number | null } | undefined;
  const lookbackDays = runRow?.lookback_days ?? 2;

  const channels = listActiveChannels(db);
  let totalNewSignals = 0;

  const llmConfig = getLlmConfig();

  for (const channel of channels) {
    try {
      const result = await pollChannel(db, channel.channel_id, {
        fetchRss: options.fetchRss,
        extractCaptions: options.extractCaptions,
        lookbackDays,
      } as PollOptions);

      totalNewSignals += result.newSignals;

      // Issue #24: auto-summarize new signals (processed_at IS NULL)
      if (result.newSignals > 0) {
        const newSignals = db.prepare(
          'SELECT video_id FROM signals WHERE channel_id = ? AND processed_at IS NULL'
        ).all(channel.channel_id) as { video_id: string }[];

        for (const signal of newSignals) {
          try {
            await analyzeSignal(db, signal.video_id, llmConfig);
          } catch (err) {
            console.error(`analyzeSignal failed for ${signal.video_id}: ${(err as Error).message}`);
            // skip, continue
          }
        }
      }

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
