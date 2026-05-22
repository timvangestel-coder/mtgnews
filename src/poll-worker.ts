import Database from 'better-sqlite3';
import { listActiveChannels } from './db/watchlist';
import { pollChannel, PollOptions } from './poll';
import { analyzeSignal, getLlmConfig } from './llm';

export interface WorkerOptions {
  fetchRss?: (channelId: string) => Promise<string>;
  extractCaptions?: (videoId: string) => Promise<Array<{ text: string; start: number; end: number }>>;
}

/** Simple concurrency-limited task pool (issue #39) */
async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  const results: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i], i).catch((err) => {
      console.error(`Task pool item ${i} failed: ${(err as Error).message}`);
    });
    results.push(p);

    if ((i + 1) % concurrency === 0 || i === items.length - 1) {
      await Promise.all(results);
      results.length = 0;
    }
  }
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

  // Issue #39: read concurrency limit from env
  const concurrency = parseInt(process.env.LLM_CONCURRENCY || '3', 10);

  const channels = listActiveChannels(db);
  let totalNewSignals = 0;

  const llmConfig = getLlmConfig();

  // Issue #39: collect all work items, process through concurrency pool
  interface WorkItem {
    type: 'poll' | 'analyze';
    channelId: string;
    videoId?: string;
  }

  const workItems: WorkItem[] = [];

  // Phase 1: poll all channels sequentially (RSS fetch order matters for progress tracking)
  for (const channel of channels) {
    try {
      const result = await pollChannel(db, channel.channel_id, {
        fetchRss: options.fetchRss,
        extractCaptions: options.extractCaptions,
        lookbackDays,
      } as PollOptions);

      totalNewSignals += result.newSignals;

      // Collect analyze tasks for new signals
      if (result.newSignals > 0) {
        const newSignals = db.prepare(
          'SELECT video_id FROM signals WHERE channel_id = ? AND processed_at IS NULL'
        ).all(channel.channel_id) as { video_id: string }[];

        for (const signal of newSignals) {
          workItems.push({ type: 'analyze', channelId: channel.channel_id, videoId: signal.video_id });
        }
      }

      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, channel.channel_id, 'done', result.newSignals, Date.now());
    } catch (err) {
      db.prepare(
        'INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, channel.channel_id, 'failed', 0, Date.now());
    }
  }

  // Phase 2: run analysis tasks through concurrency pool
  await runWithConcurrencyLimit(workItems, concurrency, async (item) => {
    if (item.type === 'analyze' && item.videoId) {
      try {
        await analyzeSignal(db, item.videoId, llmConfig);
      } catch (err) {
        console.error(`analyzeSignal failed for ${item.videoId}: ${(err as Error).message}`);
      }
    }
  });

  db.prepare(
    'UPDATE poll_runs SET status = ?, new_signal_count = ?, completed_at = ? WHERE id = ?'
  ).run('done', totalNewSignals, Date.now(), runId);
}
