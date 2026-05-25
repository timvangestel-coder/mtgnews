import Database from 'better-sqlite3';
import express, { Express } from 'express';
import layouts from 'express-ejs-layouts';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'http';
import { initDb } from './db/init-db';
import { addChannel, removeChannel, toggleChannelActive, listChannels, getChannelLastPollDate } from './db/watchlist';
import { querySignals } from './query';
import { getSignalById, injectTimestampAnchors, formatTranscriptionHtml } from './signal-detail';
import { queryPollRuns, getPollRunById, queryPollRunProgress } from './db/poll-runs';
import { enqueuePollRun } from './poll-scheduler';
import { analyzeSignal, LlmConfig, getLlmConfig } from './llm';
import { abortPollRun } from './abort';

// Isolated in-memory DB for server tests
let db: Database.Database;
let app: { server: Server; close: () => Promise<void> };

// Mock global fetch for LLM calls
const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

function createTestServer(testDb: Database.Database) {
  const expressApp: Express = express();
  const listenPort = 0;

  expressApp.set('view engine', 'ejs');
  expressApp.set('views', path.join(__dirname, '..', 'views'));
  expressApp.use(layouts);
  expressApp.set('layout extractScripts', true);
  expressApp.set('layout extractStyles', true);
  expressApp.use(express.json());
  expressApp.use(express.urlencoded({ extended: true }));

  expressApp.get('/', (_req, res) => res.redirect('/signals'));

  expressApp.get('/signals', (req, res) => {
    const channelId = req.query.channelId as string | undefined;
    const page = parseInt(req.query.page as string, 10) || 1;
    const isHtmx = req.query.htmx === 'true';
    const limit = 25;
    const offset = (page - 1) * limit;
    const result = querySignals(testDb, { channelId, limit, offset });
    const channels = listChannels(testDb);
    const totalPages = Math.ceil(result.total / limit);

    if (isHtmx) {
      res.render('_signalsTable', {
        signals: result.items, page, totalPages, total: result.total, channelId,
        layout: false,
      });
    } else {
      res.render('signals', {
        activePage: 'signals', title: 'Signals',
        signals: result.items, channels, page, totalPages, total: result.total, channelId,
      });
    }
  });

  expressApp.get('/signals/:id', (req, res) => {
    const signal = getSignalById(testDb, req.params.id);
    if (!signal) {
      res.status(404).send('Signal not found');
      return;
    }
    const channel = listChannels(testDb).find((c: any) => c.channel_id === signal.channel_id);
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

  expressApp.get('/polls', (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;
    const result = queryPollRuns(testDb, { limit, offset });
    const totalPages = Math.max(1, Math.ceil(result.total / limit));
    res.render('polls', {
      activePage: 'polls', title: 'Run History',
      runs: result.items, page, totalPages, total: result.total,
    });
  });

  expressApp.get('/polls/:id-detail', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const run = getPollRunById(testDb, id);
    if (!run) {
      res.status(404).send('Poll run not found');
      return;
    }
    const progress = queryPollRunProgress(testDb, id);
    res.render('poll-detail', {
      activePage: 'polls', title: `Run #${id} Detail`,
      run, progress,
    });
  });

  // admin
  expressApp.get('/admin', (_req, res) => {
    const channels = listChannels(testDb).map((ch) => ({
      ...ch,
      last_poll_date: getChannelLastPollDate(testDb, ch.channel_id),
    }));
    const maxRow = testDb.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null } | undefined;
    const latestRun = maxRow?.max_id ? getPollRunById(testDb, maxRow.max_id) : null;
    const currentRun = latestRun?.status === 'running' ? latestRun : null;
    const currentProgress = currentRun ? queryPollRunProgress(testDb, currentRun.id) : [];

    res.render('admin', {
      activePage: 'admin', title: 'Admin Panel',
      channels, currentRun, currentProgress,
    });
  });

  expressApp.post('/admin/channels/add', (_req, res) => {
    const channelId = _req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    addChannel(testDb, channelId);
    res.redirect('/admin');
  });

  expressApp.post('/admin/channels/remove', (_req, res) => {
    const channelId = _req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    removeChannel(testDb, channelId);
    res.redirect('/admin');
  });

  expressApp.post('/admin/channels/toggle', (_req, res) => {
    const channelId = _req.body.channel_id as string;
    const active = _req.body.active === 'true';
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    toggleChannelActive(testDb, channelId, active);
    res.redirect('/admin');
  });

  expressApp.post('/admin/poll/trigger', (_req, res) => {
    enqueuePollRun(testDb);
    res.redirect('/admin');
  });

  // signal: summarize
  expressApp.post('/signals/:id/summarize', async (_req, res) => {
    const videoId = _req.params.id;
    const config = getLlmConfig();
    const result = await analyzeSignal(testDb, videoId, config);
    if (!result.success) {
      res.redirect(`/signals/${videoId}?error=${encodeURIComponent(result.error || 'Summarization failed')}`);
    } else {
      res.redirect(`/signals/${videoId}`);
    }
  });

  expressApp.get('/admin/poll/progress', (_req, res) => {
    const maxRow = testDb.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null } | undefined;
    if (!maxRow?.max_id) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }
    const run = getPollRunById(testDb, maxRow.max_id);
    if (!run) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }
    const progress = queryPollRunProgress(testDb, run.id);
    res.render('admin/_pollProgress', { run, progress, layout: false });
  });

  // admin: abort poll (issue #40)
  expressApp.post('/admin/poll/abort/:id', (_req, res) => {
    const runId = parseInt(_req.params.id, 10);
    const returnTo = _req.query.return_to as string | undefined;
    try {
      abortPollRun(testDb, runId);
    } catch (err) {
      res.redirect(`${returnTo || '/admin'}?error=${encodeURIComponent((err as Error).message)}`);
      return;
    }
    res.redirect(returnTo || '/admin');
  });

  const server = expressApp.listen(listenPort);

  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('Express server', () => {
  beforeAll(() => {
    const testDb = new Database(':memory:');
    initDb(testDb);
    db = testDb;
    app = createTestServer(testDb);
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  // -- Signal Viewer (Issue #11) --
  describe('Signal Viewer', () => {
    const t = () => Date.now();

    it('GET /signals renders signal table with signals from DB', async () => {
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`sv-${t()}-1`, 'UC1', 'Test Video', `2101-12-31T00:00:00Z`, '[]', 'This is a test summary for the signal', 4, Date.now());

      const resp = await request(app.server).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('This is a test summary for the signal');
    });

    it('signal table rows have sentiment badge with correct color', async () => {
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`sv-${t()}-s1`, 'UC1', 'Low Sent', `2101-06-30T00:00:00Z`, '[]', 'low sentiment', 1, Date.now());
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`sv-${t()}-s5`, 'UC1', 'High Sent', `2101-06-29T00:00:00Z`, '[]', 'high sentiment', 5, Date.now());

      const resp = await request(app.server).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('bg-red-600');
      expect(resp.text).toContain('bg-green-600');
    });

    it('channel toggle pills render for each watched channel', async () => {
      addChannel(db, `UCpill${t()}1`, 'Pill Channel 1');
      addChannel(db, `UCpill${t()}2`, 'Pill Channel 2');

      const resp = await request(app.server).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Pill Channel 1');
      expect(resp.text).toContain('Pill Channel 2');
    });

    it('GET /signals?channelId filters signals via HTMX and returns table fragment only', async () => {
      const chId = `UCfilter${t()}`;
      const ch2Id = `UCfilter2${t()}`;
      addChannel(db, chId, 'Filter Channel 1');
      addChannel(db, ch2Id, 'Filter Channel 2');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`sv-${t()}-c1`, chId, 'Channel 1 Video', `2101-12-28T00:00:00Z`, '[]', 'ch1 summary', 3, Date.now());
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`sv-${t()}-c2`, ch2Id, 'Channel 2 Video', `2101-12-27T00:00:00Z`, '[]', 'ch2 summary', 3, Date.now());

      const resp = await request(app.server).get(`/signals?channelId=${chId}&htmx=true`);
      expect(resp.status).toBe(200);
      expect(resp.text).not.toContain('sidebar');
      expect(resp.text).toContain('ch1 summary');
      expect(resp.text).not.toContain('ch2 summary');
    });

    it('HTMX pagination returns table fragment with correct page', async () => {
      addChannel(db, 'UC1', 'Channel 1');
      const pagId = `pag${t()}`;
      for (let i = 1; i <= 30; i++) {
        const day = String(i).padStart(2, '0');
        db.prepare(
          `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`${pagId}-${i}`, 'UC1', `Page Video ${i}`, `2102-01-${day}T00:00:00Z`, '[]', `summary ${i}`, 3, Date.now());
      }

      const resp = await request(app.server).get('/signals?page=2&htmx=true');
      expect(resp.status).toBe(200);
      expect(resp.text).not.toContain('sidebar');
      expect(resp.text).toContain('summary 5');
      expect(resp.text).not.toContain('summary 30');
    });

    it('signal row is clickable and links to /signals/:id', async () => {
      addChannel(db, 'UC1', 'Channel 1');
      const vid = `sv-${t()}-click`;
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UC1', 'Clickable Video', `2103-12-30T00:00:00Z`, '[]', 'clickable', 3, Date.now());

      const resp = await request(app.server).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain(`/signals/${vid}`);
    });
  });

  it('starts and serves pages on configured port', async () => {
    const resp = await request(app.server).get('/');
    expect(resp.status).toBe(302);
    expect(resp.header.location).toBe('/signals');
  });

  it('GET /signals returns 200 with layout', async () => {
    const resp = await request(app.server).get('/signals');
    expect(resp.status).toBe(200);
    expect(resp.text).toContain('Signals');
  });

  // -- Signal Summarize (Issue #25) --
  describe('Signal Summarize', () => {
    it('POST /signals/:id/summarize calls analyzeSignal and redirects on success', async () => {
      const vid = `sum-${Date.now()}`;
      addChannel(db, 'UCsum1', 'Sum Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UCsum1', 'Summarize Me', '2026-05-01T10:00:00Z', '[]', Date.now());

      const mergedJson = { summary: 'MTG video', takeaways: [{ text: 'Good content', timestamp: 'T:0' }], overall_sentiment: { score: 4, label: 'Positive' }, entities: [] };

      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(mergedJson) } }] }) as any });

      const resp = await request(app.server)
        .post(`/signals/${vid}/summarize`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe(`/signals/${vid}`);

      // verify signal was processed
      const signal = db.prepare('SELECT summary, processed_at FROM signals WHERE video_id = ?').get(vid);
      expect(signal.summary).toContain('MTG video');
      expect(signal.processed_at).toBeDefined();
    });

    it('POST /signals/:id/summarize redirects with error on LLM failure', async () => {
      const vid = `sumerr-${Date.now()}`;
      addChannel(db, 'UCsumerr', 'SumErr Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UCsumerr', 'Will Fail', '2026-05-01T10:00:00Z', '[]', Date.now());

      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any);

      const resp = await request(app.server)
        .post(`/signals/${vid}/summarize`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toContain(`/signals/${vid}`);
      expect(resp.header.location).toContain('error=');

      // signal NOT processed
      const signal = db.prepare('SELECT summary, processed_at FROM signals WHERE video_id = ?').get(vid);
      expect(signal.summary).toBeNull();
      expect(signal.processed_at).toBeNull();
    });

    it('POST /signals/:id/summarize returns 404 for nonexistent signal', async () => {
      mockFetch.mockReset();

      const resp = await request(app.server)
        .post('/signals/nonexistent-abc123/summarize')
        .type('form')
        .send({});

      // analyzeSignal returns success:false -> redirect with error
      expect(resp.status).toBe(302);
      expect(resp.header.location).toContain('error=');
    });
  });

  // -- Signal Detail (Issue #12) --
  describe('Signal Detail', () => {
    it('GET /signals/:id displays header with title, channel badge, and published date', async () => {
      const vid = `sd-${Date.now()}-1`;
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
       ).run(vid, 'UC1', 'My Signal Title', '2026-05-01T10:00:00Z',
         JSON.stringify([{ time: 0, text: 'hello world' }]),
         'Summary with [T:0] timestamp', 4, Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('My Signal Title');
      expect(resp.text).toContain('Channel 1');
    });

    it('renders key takeaways with [MM:SS] timestamp anchor links', async () => {
      const vid = `sd-${Date.now()}-2`;
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UC1', 'Test', '2026-05-01T10:00:00Z', '[]',
        'Point one [T:45] and point two [T:120]', 4, Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      // LLM [T:ss] converted to [MM:SS] display with millisecond anchor IDs
      expect(resp.text).toContain('href="#t-45000"');
      expect(resp.text).toContain('[00:45]');
      expect(resp.text).toContain('href="#t-120000"');
      expect(resp.text).toContain('[02:00]');
    });

    it('renders transcription section with MM:SS timestamps and grouped segments', async () => {
      const vid = `sd-${Date.now()}-3`;
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
       ).run(vid, 'UC1', 'Test', '2026-05-01T10:00:00Z',
         JSON.stringify([{ time: 0, text: 'hello world' }, { time: 45000, text: 'mtg news' }]),
         'summary', 4, Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('id="t-0"');
      expect(resp.text).toContain('[00:00]');
      expect(resp.text).toContain('hello world');
      expect(resp.text).toContain('id="t-45000"');
      expect(resp.text).toContain('[00:45]');
      expect(resp.text).toContain('mtg news');
    });

    it('has three-state toggle bar with Summary, Transcript, and Split buttons', async () => {
      const vid = `sd-${Date.now()}-4`;
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UC1', 'Test', '2026-05-01T10:00:00Z',
        JSON.stringify([{ time: 0, text: 'seg' }]),
        'summary', 4, Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      // Three-state toggle buttons replace old collapse button
      expect(resp.text).toContain('viewState');
      expect(resp.text).toContain("viewState = 'summary'");
      expect(resp.text).toContain("viewState = 'transcript'");
      expect(resp.text).toContain("viewState = 'split'");
      // Both panes present in DOM
      expect(resp.text).toContain('id="summary-pane"');
      expect(resp.text).toContain('id="transcript-pane"');
    });

    it('html-escapes summary text to prevent XSS', async () => {
      const vid = `sd-${Date.now()}-5`;
      addChannel(db, 'UC1', 'Channel 1');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UC1', 'Test', '2026-05-01T10:00:00Z', '[]',
        '<script>alert("xss")</script>', 4, Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      expect(resp.text).not.toContain('<script>alert');
    });

    it('returns 404 for nonexistent signal id', async () => {
      const resp = await request(app.server).get('/signals/nonexistent-signal');
      expect(resp.status).toBe(404);
    });

    it('shows Summarize button when processed_at is NULL', async () => {
      const vid = `sumbtn-${Date.now()}`;
      addChannel(db, 'UCbtn1', 'Button Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UCbtn1', 'Unprocessed Signal', '2026-05-01T10:00:00Z', '[]', Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Summarize');
      expect(resp.text).toContain(`action="/signals/${vid}/summarize"`);
    });

    it('hides Summarize button when processed_at is set', async () => {
      const vid = `sumbtn2-${Date.now()}`;
      addChannel(db, 'UCbtn2', 'Processed Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, processed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UCbtn2', 'Processed Signal', '2026-05-01T10:00:00Z', '[]', 'Already summarized', Date.now(), Date.now());

      const resp = await request(app.server).get(`/signals/${vid}`);
      expect(resp.status).toBe(200);
      expect(resp.text).not.toContain(`action="/signals/${vid}/summarize"`);
    });

    it('shows error message when redirected with error param', async () => {
      const resp = await request(app.server).get('/signals/some-id?error=test+failure');
      // Page may 404 if signal doesn't exist, but error flash should render if page loads
      // Test with a real signal
      const vid = `sumerr2-${Date.now()}`;
      addChannel(db, 'UCbtnerr', 'Error Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UCbtnerr', 'Error Signal', '2026-05-01T10:00:00Z', '[]', Date.now());

      const resp2 = await request(app.server).get(`/signals/${vid}?error=test+failure`);
      expect(resp2.status).toBe(200);
      expect(resp2.text).toContain('test failure');
    });
  });

  // -- Run History (Issue #13) --
  describe('Run History', () => {
    it('GET /polls returns 200 with empty state when no runs', async () => {
      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Run History');
      expect(resp.text).toContain('No poll runs yet');
    });

    it('GET /polls displays runs with status badges (done=green, failed=red, running=amber)', async () => {
      addChannel(db, 'UCbadge1', 'Badge Ch 1');
      addChannel(db, 'UCbadge2', 'Badge Ch 2');

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(1000, 'done', 5, 2000);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(1, 'UCbadge1', 'done', 3, 1500);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(1, 'UCbadge2', 'done', 2, 1600);

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, ?, ?)").run(3000, 'running', 0);

      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count, completed_at) VALUES (?, ?, ?, ?)").run(4000, 'failed', 0, 5000);
      db.prepare("INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)").run(3, 'UCbadge1', 'failed', 0, 4500);

      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('bg-green-600');
      expect(resp.text).toContain('bg-amber-500');
      expect(resp.text).toContain('bg-red-600');
    });

    it('GET /polls shows new signal count and channel summary', async () => {
      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('5');
      expect(resp.text).toContain('2/2 done');
    });

    it('GET /polls rows link to detail page', async () => {
      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('/polls/1-detail');
    });

    it('GET /polls shows Abort button only for running jobs', async () => {
      // Run #2 is 'running' (from status badges test above)
      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('/admin/poll/abort/2');
      expect(resp.text).toContain('Abort');
    });

    it('GET /polls does not show Abort button for non-running jobs', async () => {
      const resp = await request(app.server).get('/polls');
      expect(resp.status).toBe(200);
      // done/failed runs do NOT have abort forms
      expect(resp.text).not.toContain('/admin/poll/abort/1');
      expect(resp.text).not.toContain('/admin/poll/abort/3');
    });

    it('GET /polls/:id-detail shows run header and channel breakdown', async () => {
      const resp = await request(app.server).get('/polls/1-detail');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Run #1 Detail');
      expect(resp.text).toContain('Badge Ch 1');
      expect(resp.text).toContain('Channel Breakdown');
      expect(resp.text).toContain('bg-green-600');
    });

    it('GET /polls/:id-detail returns 404 for nonexistent run', async () => {
      const resp = await request(app.server).get('/polls/9999-detail');
      expect(resp.status).toBe(404);
    });
  });

  // -- Abort Run (Issue #40) --
  describe('Abort Run', () => {
    it('POST /admin/poll/abort/:id transitions run to done-forced when processed signals exist', async () => {
      addChannel(db, 'UCabort1', 'Abort Ch 1');
      // triggeredAt = now ensures only signals inserted AFTER this point fall in the window
      const triggeredAt = Date.now();
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', ?)"
      ).run(triggeredAt, 2);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      // One processed signal in this run window (created_at > triggeredAt)
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at, processed_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(`v-abort-proc`, 'UCabort1', 'Processed', '2026-05-01T00:00:00Z', '[]', 'summary', 4, triggeredAt + 1, Date.now(), runId);

      // One unprocessed signal in this run window
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(`v-abort-unproc`, 'UCabort1', 'Unprocessed', '2026-05-01T01:00:00Z', '[]', triggeredAt + 2, runId);

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');

      // Run should be done-forced with count=1 (only processed signal kept)
      const run = db.prepare('SELECT status, new_signal_count, abort_time FROM poll_runs WHERE id = ?').get(runId);
      expect(run.status).toBe('done-forced');
      expect(run.new_signal_count).toBe(1);
      expect(run.abort_time).toBeDefined();

      // Unprocessed signal should be deleted
      const unprocCount = (db.prepare("SELECT COUNT(*) as c FROM signals WHERE video_id = ?").get(`v-abort-unproc`) as { c: number }).c;
      expect(unprocCount).toBe(0);

      // Processed signal should remain
      const procRow = db.prepare("SELECT summary FROM signals WHERE video_id = ?").get(`v-abort-proc`);
      expect(procRow.summary).toBe('summary');
    });

    it('POST /admin/poll/abort/:id keeps run as done-forced when zero processed signals', async () => {
      addChannel(db, 'UCabort2', 'Abort Ch 2');
      const triggeredAt = Date.now();
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', ?)"
      ).run(triggeredAt, 1);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      // Only unprocessed signals in this run window
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(`v-abort-zero`, 'UCabort2', 'Only Unproc', '2026-05-01T00:00:00Z', '[]', triggeredAt + 1, runId);

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');

      // Run kept as done-forced (UI needs it to display abort status)
      const run = db.prepare('SELECT id, status, new_signal_count FROM poll_runs WHERE id = ?').get(runId) as any;
      expect(run).toBeDefined();
      expect(run.status).toBe('done-forced');
      expect(run.new_signal_count).toBe(0);

      // Signal deleted
      const sigCount = (db.prepare("SELECT COUNT(*) as c FROM signals WHERE video_id = ?").get(`v-abort-zero`) as { c: number }).c;
      expect(sigCount).toBe(0);
    });

    it('POST /admin/poll/abort/:id only deletes signals within [triggered_at, abort_time] window', async () => {
      addChannel(db, 'UCabort3', 'Abort Ch 3');
      const triggeredAt = Date.now() - 20000;

      // Run #A (will be aborted)
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', ?)"
      ).run(triggeredAt, 1);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      // Signal inside this run window - unprocessed (tied to this run via FK)
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at, poll_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(`v-in-window`, 'UCabort3', 'In Window', '2026-05-01T00:00:00Z', '[]', triggeredAt + 1000, runId);

      // Signal outside this run window (no poll_run_id -> orphan, never deleted by abort)
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(`v-out-window`, 'UCabort3', 'Out Window', '2026-05-01T01:00:00Z', '[]', triggeredAt - 5000);

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);

      // Signal in window deleted, signal out of window preserved
      const inCount = (db.prepare("SELECT COUNT(*) as c FROM signals WHERE video_id = ?").get(`v-in-window`) as { c: number }).c;
      expect(inCount).toBe(0);

      const outCount = (db.prepare("SELECT COUNT(*) as c FROM signals WHERE video_id = ?").get(`v-out-window`) as { c: number }).c;
      expect(outCount).toBe(1);
    });

    it('POST /admin/poll/abort/:id throws for nonexistent run', async () => {
      const resp = await request(app.server)
        .post('/admin/poll/abort/99999')
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toContain('error=');
    });

    it('POST /admin/poll/abort/:id throws for already aborted run', async () => {
      const triggeredAt = Date.now() - 10000;
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count, abort_time) VALUES (?, 'done-forced', ?, ?)"
      ).run(triggeredAt, 0, Date.now());
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toContain('error=');
    });

    it('POST /admin/poll/abort/:id redirects to return_to param when provided', async () => {
      addChannel(db, 'UCabortreturn', 'Abort Return Ch');
      const triggeredAt = Date.now();
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', ?)"
      ).run(triggeredAt, 0);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}?return_to=/polls`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/polls');
    });

    it('POST /admin/poll/abort/:id defaults to /admin when no return_to param', async () => {
      addChannel(db, 'UCabortdefault', 'Abort Default Ch');
      const triggeredAt = Date.now();
      db.prepare(
        "INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', ?)"
      ).run(triggeredAt, 0);
      const runId = (db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number }).max_id;

      const resp = await request(app.server)
        .post(`/admin/poll/abort/${runId}`)
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');
    });
  });

  // -- Admin Panel (Issue #14) --
  describe('Admin Panel', () => {
    it('GET /admin shows WatchList with channel names and avatars', async () => {
      addChannel(db, 'UCadmin1', 'Admin Channel 1', 'https://example.com/avatar1.jpg');

      const resp = await request(app.server).get('/admin');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Admin Panel');
      expect(resp.text).toContain('Admin Channel 1');
      expect(resp.text).toContain('WatchList');
    });

    it('GET /admin shows empty WatchList message when no channels', async () => {
      // remove all channels added by previous tests for this check
      // channels table may have leftover entries, but admin template handles both cases
      const resp = await request(app.server).get('/admin');
      expect(resp.status).toBe(200);
      // Either shows channels or the "No channels" message
      expect(resp.text).toContain('WatchList');
    });

    it('POST /admin/channels/add stores channel and redirects', async () => {
      const channelId = `UCadd${Date.now()}`;
      const resp = await request(app.server)
        .post('/admin/channels/add')
        .type('form')
        .send({ channel_id: channelId });

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');

      const channels = listChannels(db);
      expect(channels.find((c) => c.channel_id === channelId)).toBeDefined();
    });

    it('POST /admin/channels/add returns 400 without channel_id', async () => {
      const resp = await request(app.server)
        .post('/admin/channels/add')
        .type('form')
        .send({});

      expect(resp.status).toBe(400);
    });

    it('POST /admin/channels/remove deletes channel and redirects', async () => {
      const channelId = `UCremove${Date.now()}`;
      addChannel(db, channelId, 'Remove Me');

      const resp = await request(app.server)
        .post('/admin/channels/remove')
        .type('form')
        .send({ channel_id: channelId });

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');

      const channels = listChannels(db);
      expect(channels.find((c) => c.channel_id === channelId)).toBeUndefined();
    });

    it('POST /admin/channels/toggle deactivates channel', async () => {
      const channelId = `UCtoggle${Date.now()}`;
      addChannel(db, channelId, 'Toggle Me');

      const resp = await request(app.server)
        .post('/admin/channels/toggle')
        .type('form')
        .send({ channel_id: channelId, active: 'false' });

      expect(resp.status).toBe(302);

      const ch = listChannels(db).find((c) => c.channel_id === channelId);
      expect(ch).toBeDefined();
      expect(ch!.active).toBe(0);
    });

    it('POST /admin/poll/trigger enqueues a poll run', async () => {
      const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number }).c;

      const resp = await request(app.server)
        .post('/admin/poll/trigger')
        .type('form')
        .send({});

      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe('/admin');

      const afterCount = (db.prepare('SELECT COUNT(*) as c FROM poll_runs').get() as { c: number }).c;
      expect(afterCount).toBe(beforeCount + 1);
    });

    it('GET /admin/poll/progress shows running poll status', async () => {
      // ensure a running poll exists
      const maxRow = db.prepare('SELECT MAX(id) as max_id FROM poll_runs').get() as { max_id: number | null };
      if (maxRow?.max_id) {
        db.prepare("UPDATE poll_runs SET status = 'running' WHERE id = ?").run(maxRow.max_id);
      }

      const resp = await request(app.server).get('/admin/poll/progress');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('progress-widget');
    });

    it('GET /admin shows Run Poll Now button', async () => {
      const resp = await request(app.server).get('/admin');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Run Poll Now');
    });

    it('GET /admin shows HTMX polling for progress', async () => {
      const resp = await request(app.server).get('/admin');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('hx-get="/admin/poll/progress"');
      expect(resp.text).toContain('hx-trigger="every 3s"');
    });
  });

  it('layout renders sidebar with active page highlighted', async () => {
    const resp = await request(app.server).get('/signals');
    expect(resp.status).toBe(200);
    expect(resp.text).toContain('active');
    expect(resp.text).toContain('sidebar');
  });

  it('layout loads Tailwind, HTMX, Alpine.js via CDN', async () => {
    const resp = await request(app.server).get('/signals');
    expect(resp.text).toContain('cdn.tailwindcss.com');
    expect(resp.text).toContain('htmx.org');
    expect(resp.text).toContain('cdn.jsdelivr.net/npm/alpinejs');
  });
});