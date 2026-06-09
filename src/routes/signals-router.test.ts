import Database from 'better-sqlite3';
import express, { Express } from 'express';
import layouts from 'express-ejs-layouts';
import path from 'path';
import request from 'supertest';
import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';
import { SignalQueryService } from '../services/signal-query-service';
import { createSignalsRouter } from './signals-router';

// Mock LLM so summarize doesn't hit network
vi.mock('../llm', () => ({
  analyzeSignal: vi.fn().mockResolvedValue({ success: true }),
  getLlmConfig: () => ({ endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' }),
}));

let db: Database.Database;
let httpServer: Server;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  const service = new SignalQueryService(db);

  const app: Express = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(layouts);
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const router = createSignalsRouter(service);
  app.use('/', router);

  // Error handler to surface EJS rendering errors
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Express error:', err?.message, err?.stack);
    res.status(500).send(err?.message || 'Internal server error');
  });

  httpServer = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err: Error | null) => (err ? reject(err) : resolve()));
  });
  db.close();
});

describe('Signals Router', () => {
  describe('GET /signals', () => {
    it('returns 200 with signals page', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Signals');
    });

    it('renders _signalsTable fragment when ?htmx=true', async () => {
      const resp = await request(httpServer).get('/signals?htmx=true');
      expect(resp.status).toBe(200);
      // Fragment should NOT contain layout/sidebar
      expect(resp.text).not.toContain('sidebar');
    });

    it('filters by channelId via HTMX', async () => {
      const t = Date.now();
      addChannel(db, `UCrouter${t}`, 'Router Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vrouter-${t}`, `UCrouter${t}`, 'Router Video', `2103-12-31T00:00:00Z`, '[]', 'router summary', 4, Date.now());

      const resp = await request(httpServer).get(`/signals?channelId=UCrouter${t}&htmx=true`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Router Video');
    });

    it('respects showIrrelevant query param', async () => {
      const t = Date.now();
      addChannel(db, `UCirrR${t}`, 'Irr Router Ch');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, processing_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`virrR-${t}`, `UCirrR${t}`, 'Irrelevant R', `2103-12-30T00:00:00Z`, '[]', 'irrelevant r summary', 4, 'irrelevant', Date.now());

      // Without showIrrelevant
      const resp1 = await request(httpServer).get(`/signals?channelId=UCirrR${t}&htmx=true`);
      expect(resp1.status).toBe(200);
      expect(resp1.text).not.toContain('Irrelevant R');

      // With showIrrelevant=true
      const resp2 = await request(httpServer).get(`/signals?channelId=UCirrR${t}&showIrrelevant=true&htmx=true`);
      expect(resp2.status).toBe(200);
      expect(resp2.text).toContain('[Irrelevant]');
    });

    it('passes topicKey filter', async () => {
      // Topic filter is passed through to service; verify no error when provided
      const resp = await request(httpServer).get('/signals?topicKey=meta&htmx=true');
      expect(resp.status).toBe(200);
    });
  });

  describe('GET /signals/:id', () => {
    it('returns 404 for nonexistent signal', async () => {
      const resp = await request(httpServer).get('/signals/nonexistent-abc123');
      expect(resp.status).toBe(404);
    });

    it('renders signal detail with summary and transcription', async () => {
      const t = Date.now();
      addChannel(db, `UCdetailR${t}`, 'Detail Router Ch');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `vdetailR-${t}`, `UCdetailR${t}`, 'Detail Router Video', `2103-12-31T00:00:00Z`,
        JSON.stringify([{ time: 0, text: 'hello router' }]),
        'Router summary [T:0]', 4, Date.now()
      );

      const resp = await request(httpServer).get(`/signals/vdetailR-${t}`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('Detail Router Video');
      expect(resp.text).toContain('hello router');
    });

    it('places Summarize button inside toggle bar when signal not processed', async () => {
      const t = Date.now();
      addChannel(db, `UCsumBtn${t}`, 'Sum Button Ch');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`vsumBtn-${t}`, `UCsumBtn${t}`, 'Sum Button Video', `2103-12-31T00:00:00Z`, '[]', Date.now());

      const resp = await request(httpServer).get(`/signals/vsumBtn-${t}`);
      expect(resp.status).toBe(200);

      // The toggle bar uses "flex gap-2 mb-4" class
      const toggleBarStart = resp.text.indexOf('flex gap-2 mb-4');
      expect(toggleBarStart).toBeGreaterThan(-1);

      // Find the closing </div> of the toggle bar (after Split button text)
      const splitPos = resp.text.indexOf('Split', toggleBarStart);
      expect(splitPos).toBeGreaterThan(-1);
      const toggleBarEnd = resp.text.indexOf('</div>', splitPos);

      // The ms-auto class must appear within the toggle bar (pushes Summarize right)
      const msAutoPos = resp.text.indexOf('ms-auto', toggleBarStart);
      expect(msAutoPos).toBeGreaterThan(toggleBarStart);
      expect(msAutoPos).toBeLessThan(toggleBarEnd);

      // The summarize action URL must appear within the toggle bar
      const actionPos = resp.text.indexOf(`/signals/vsumBtn-${t}/summarize`, toggleBarStart);
      expect(actionPos).toBeGreaterThan(toggleBarStart);
      expect(actionPos).toBeLessThan(toggleBarEnd);

      // "Summarize" button text must be present within the toggle bar
      const sumButtonPos = resp.text.indexOf('Summarize', toggleBarStart);
      expect(sumButtonPos).toBeGreaterThan(toggleBarStart);
      expect(sumButtonPos).toBeLessThan(toggleBarEnd);
    });

    it('shows error message when error query param present', async () => {
      const t = Date.now();
      addChannel(db, `UCerrR${t}`, 'Error Router Ch');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`verrR-${t}`, `UCerrR${t}`, 'Error Video', `2103-12-31T00:00:00Z`, '[]', Date.now());

      const resp = await request(httpServer).get(`/signals/verrR-${t}?error=llm+failed`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('llm failed');
    });
  });

  describe('POST /signals/:id/summarize', () => {
    it('redirects to signal detail on success', async () => {
      const t = Date.now();
      addChannel(db, `UCsumR${t}`, 'Sum Router Ch');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`vsumR-${t}`, `UCsumR${t}`, 'Sum Router Video', `2103-12-31T00:00:00Z`, '[]', Date.now());

      const resp = await request(httpServer).post(`/signals/vsumR-${t}/summarize`);
      expect(resp.status).toBe(302);
      expect(resp.header.location).toBe(`/signals/vsumR-${t}`);
    });

    it('redirects with error when signal not found', async () => {
      const resp = await request(httpServer).post('/signals/nonexistent-xyz/summarize');
      expect(resp.status).toBe(302);
      expect(resp.header.location).toContain('error=');
    });
  });
});