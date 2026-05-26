import express, { Express } from 'express';
import layouts from 'express-ejs-layouts';
import path from 'path';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { db } from './index';
import { startScheduledPolling } from './scheduler';
import { querySignals } from './query';
import { listChannels, addChannel, removeChannel, toggleChannelActive, updateChannelTopic, getChannelLastPollDate } from './db/watchlist';
import { createTopic, listTopics, updateTopic, deleteTopic } from './db/topics';
import { getSignalById } from './signal-detail';
import { injectTimestampAnchors, formatTranscriptionHtml } from './signal-detail';
import { analyzeSignal, getLlmConfig } from './llm';
import { queryPollRuns, getPollRunById, queryPollRunProgress } from './db/poll-runs';
import { enqueuePollRun, registerRun } from './poll-scheduler';
import { fetchChannelInfo } from './rss-discovery';
import { abortPollRun } from './abort';

export interface ServerOptions {
  port?: number;
  startScheduler?: boolean;
  database?: Database.Database;
}

export interface ServerApp {
  server: Server;
  close: () => Promise<void>;
}

export function createServer(options: ServerOptions | number = {}): ServerApp {
  const opts = typeof options === 'number' ? { port: options } : options;
  const listenPort = opts.port || parseInt(process.env.PORT || '3000', 10);
  const useDb = opts.database ?? db;

  const app: Express = express();

  // view engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(layouts);
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);

  // static
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // start background worker (opt-out for tests)
  if (opts.startScheduler !== false) {
    startScheduledPolling(db);
  }

  // redirect root
  app.get('/', (_req, res) => res.redirect('/signals'));

  // signals
  app.get('/signals', (req, res) => {
    const channelId = req.query.channelId as string | undefined;
    const topicKey = req.query.topicKey as string | undefined;
    const showIrrelevant = req.query.showIrrelevant === 'true';
    const page = parseInt(req.query.page as string, 10) || 1;
    const isHtmx = req.query.htmx === 'true';
    const limit = 25;
    const offset = (page - 1) * limit;

    const result = querySignals(useDb, { channelId, topicKey: topicKey || undefined, includeIrrelevant: showIrrelevant, limit, offset });
    const rawChannels = listChannels(useDb);
    // Add topic_key for Alpine.js filtering in UI
    const channels = rawChannels.map((ch) => ({
      ...ch,
      topic_key: ch.topic_id ? (listTopics(useDb).find((t) => t.id === ch.topic_id)?.key ?? null) : null,
    }));
    const topics = listTopics(useDb);
    const totalPages = Math.ceil(result.total / limit);

    if (isHtmx) {
      res.render('_signalsTable', {
        signals: result.items,
        page,
        totalPages,
        total: result.total,
        channelId,
        topicKey,
        showIrrelevant,
        layout: false,
      });
    } else {
      res.render('signals', {
        activePage: 'signals',
        title: 'Signals',
        signals: result.items,
        channels,
        topics,
        page,
        totalPages,
        total: result.total,
        channelId,
        topicKey,
        showIrrelevant,
      });
    }
  });

  app.get('/signals/:id', (req, res) => {
    const signal = getSignalById(useDb, req.params.id);
    if (!signal) {
      res.status(404).send('Signal not found');
      return;
    }

    const channel = listChannels(useDb).find((c: any) => c.channel_id === signal.channel_id);
    const summaryHtml = signal.summary ? injectTimestampAnchors(signal.summary) : '';
    const transcriptionHtml = formatTranscriptionHtml(signal.transcription);

    res.render('signal-detail', {
      activePage: 'signals',
      title: signal.title || 'Signal Detail',
      signal,
      channel,
      summaryHtml,
      transcriptionHtml,
      error: req.query.error as string | undefined,
    });
  });

  // signal: summarize
  app.post('/signals/:id/summarize', async (req, res) => {
    const videoId = req.params.id;
    const config = getLlmConfig();
    const result = await analyzeSignal(useDb, videoId, config);
    if (!result.success) {
      res.redirect(`/signals/${videoId}?error=${encodeURIComponent(result.error || 'Summarization failed')}`);
    } else {
      res.redirect(`/signals/${videoId}`);
    }
  });

  // polls / run history
  app.get('/polls', (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;

    const result = queryPollRuns(useDb, { limit, offset });
    const totalPages = Math.max(1, Math.ceil(result.total / limit));

    res.render('polls', {
      activePage: 'polls',
      title: 'Run History',
      runs: result.items,
      page,
      totalPages,
      total: result.total,
    });
  });

  app.get('/polls/:id-detail', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const run = getPollRunById(useDb, id);
    if (!run) {
      res.status(404).send('Poll run not found');
      return;
    }
    const progress = queryPollRunProgress(useDb, id);

    res.render('poll-detail', {
      activePage: 'polls',
      title: `Run #${id} Detail`,
      run,
      progress,
    });
  });

  // admin
  app.get('/admin', (_req, res) => {
    const channels = listChannels(useDb);
    const channelsWithLastPoll = channels.map((ch) => ({
      ...ch,
      last_poll_date: getChannelLastPollDate(useDb, ch.channel_id),
    }));

    // Topics with channel counts
    const topics = listTopics(useDb).map((t) => ({
      ...t,
      channel_count: (useDb.prepare('SELECT COUNT(*) as c FROM channels WHERE topic_id = ?').get(t.id) as { c: number }).c,
    }));

    // check for current running poll
    const latestRun = getPollRunById(useDb, (useDb.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null })?.max_id ?? -1);
    const currentRun = latestRun?.status === 'running' ? latestRun : null;
    const currentProgress = currentRun ? queryPollRunProgress(useDb, currentRun.id) : [];

    res.render('admin', {
      activePage: 'admin',
      title: 'Admin Panel',
      channels: channelsWithLastPoll,
      topics,
      currentRun,
      currentProgress,
    });
  });

  // admin: create topic (Issue #51)
  app.post('/admin/topics', (req, res) => {
    const key = req.body.key as string;
    const shortName = req.body.short_name as string;
    const filterText = req.body.filter_text as string;
    if (!key) {
      res.status(400).send('key required');
      return;
    }
    try {
      createTopic(useDb, key, shortName || '', filterText || '');
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('UNIQUE constraint failed') || msg.includes('duplicate key')) {
        res.status(400).send(`Duplicate key: ${key}`);
        return;
      }
      throw err;
    }
    res.redirect('/admin');
  });

  // admin: update topic (Issue #51)
  app.post('/admin/topics/update', (req, res) => {
    const id = parseInt(req.body.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('id required');
      return;
    }
    const opts: { key?: string; short_name?: string; filter_text?: string } = {};
    if (req.body.key !== undefined) opts.key = req.body.key as string;
    if (req.body.short_name !== undefined) opts.short_name = req.body.short_name as string;
    if (req.body.filter_text !== undefined) opts.filter_text = req.body.filter_text as string;
    updateTopic(useDb, id, opts);
    res.redirect('/admin');
  });

  // admin: delete topic (Issue #51)
  app.post('/admin/topics/delete', (req, res) => {
    const id = parseInt(req.body.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('id required');
      return;
    }
    deleteTopic(useDb, id);
    res.redirect('/admin');
  });

  // admin: add channel
  app.post('/admin/channels/add', async (req, res) => {
    const rawInput = req.body.channel_id as string;
    if (!rawInput) {
      res.status(400).send('channel_id required');
      return;
    }

    // resolve handle/URL to UC ID
    let channelId: string;
    try {
      const { resolveChannelId } = await import('./rss-discovery');
      channelId = await resolveChannelId(rawInput);
    } catch {
      // if resolution fails, use input as-is (may already be UC ID)
      channelId = rawInput;
    }

    // try to fetch channel info from RSS
    let displayName = '';
    let avatarUrl = '';
    try {
      const info = await fetchChannelInfo(channelId);
      if (info) {
        displayName = info.display_name;
        avatarUrl = info.avatar_url;
      }
    } catch {
      // ignore fetch errors, store with empty info
    }

    const topicId = req.body.topic_id ? parseInt(req.body.topic_id as string, 10) : null;
    addChannel(useDb, channelId, displayName || undefined, avatarUrl || undefined, topicId);
    res.redirect('/admin');
  });

  // admin: update channel topic
  app.post('/admin/channels/update-topic', (req, res) => {
    const channelId = req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    const topicId = req.body.topic_id ? parseInt(req.body.topic_id as string, 10) : null;
    updateChannelTopic(useDb, channelId, topicId);
    res.redirect('/admin');
  });

  // admin: remove channel
  app.post('/admin/channels/remove', (req, res) => {
    const channelId = req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    removeChannel(useDb, channelId);
    res.redirect('/admin');
  });

  // admin: toggle channel active
  app.post('/admin/channels/toggle', (req, res) => {
    const channelId = req.body.channel_id as string;
    const active = req.body.active === 'true';
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    toggleChannelActive(useDb, channelId, active);
    res.redirect('/admin');
  });

  // admin: trigger poll
  app.post('/admin/poll/trigger', (req, res) => {
    const raw = req.body.lookback_days;
    const lookbackDays = raw ? parseInt(raw as string, 10) : 2;
    const runId = enqueuePollRun(useDb, lookbackDays);
    // Create AbortController so abort endpoint can cancel this run
    const controller = new AbortController();
    // run in background (non-blocking)
    import('./poll-worker').then(({ workerProcessRun }) => {
      const worker = workerProcessRun(useDb, runId, { signal: controller.signal }).catch(console.error);
      registerRun(runId, controller, worker);
    });
    res.redirect('/admin');
  });

  // admin: abort poll (issue #40)
  app.post('/admin/poll/abort/:id', (req, res) => {
    const runId = parseInt(req.params.id, 10);
    const returnTo = req.query.return_to as string | undefined;
    try {
      abortPollRun(useDb, runId);
    } catch (err) {
      res.redirect(`${returnTo || '/admin'}?error=${encodeURIComponent((err as Error).message)}`);
      return;
    }
    res.redirect(returnTo || '/admin');
  });

  // admin: get poll progress (HTMX endpoint)
  app.get('/admin/poll/progress', (req, res) => {
    const latestRunId = useDb.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null };
    if (!latestRunId?.max_id) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    const run = getPollRunById(useDb, latestRunId.max_id);
    if (!run) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    const progress = queryPollRunProgress(useDb, run.id);

    res.render('admin/_pollProgress', {
      run,
      progress,
      layout: false,
    });
  });

  const server = app.listen(listenPort, () => {
    console.log(`Dashboard server listening on port ${listenPort}`);
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}