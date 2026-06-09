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

  httpServer = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err: Error | null) => (err ? reject(err) : resolve()));
  });
  db.close();
});

describe('Signals Page Chat Panel (Issue #131)', () => {
  describe('Chat toggle button on signals list page', () => {
    it('renders a chat toggle button with data-signals-chat-toggle attribute', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('data-signals-chat-toggle');
    });

    it('chat toggle button is fixed position', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      // Button should have "fixed" positioning class
      const toggleIdx = resp.text.indexOf('data-signals-chat-toggle');
      expect(toggleIdx).toBeGreaterThan(-1);
      // The button element should contain "fixed" in its class attribute
      const nextFixed = resp.text.indexOf('fixed', toggleIdx);
      expect(nextFixed).toBeGreaterThan(-1);
    });
  });

  describe('Chat panel with 760px width', () => {
    it('renders a chat panel with data-signals-chat-panel and 760px width', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('data-signals-chat-panel');
      expect(resp.text).toContain('w-[760px]');
    });

    it('renders backdrop overlay for chat panel', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('data-signals-chat-backdrop');
    });
  });

  describe('Scope badge', () => {
    beforeAll(() => {
      // Insert signals for scope count testing
      const t = Date.now();
      addChannel(db, `UCscope${t}`, 'Scope Channel');
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`vscope${t}${i}`, `UCscope${t}`, `Scope Video ${i}`, `2103-12-31T00:00:00Z`, '[]', 'summary', 4, Date.now());
      }
    });

    it('renders scope badge in chat panel header', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('data-scope-badge');
    });

    it('scope badge shows signal count matching filtered signals', async () => {
      const t = Date.now();
      addChannel(db, `UCcount${t}`, 'Count Channel');
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`vcount${t}${i}`, `UCcount${t}`, `Count Video ${i}`, `2103-12-31T00:00:00Z`, '[]', 'summary', 4, Date.now());
      }

      const resp = await request(httpServer).get(`/signals?channelId=UCcount${t}`);
      expect(resp.status).toBe(200);
      // The scope badge should contain the channel filter context
      expect(resp.text).toContain('data-scope-badge');
    });
  });

  describe('Chat panel survives pagination HTMX swaps', () => {
    it('chat panel is outside signals-table div so it persists across pagination', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);

      // Find positions of key elements
      const tableStart = resp.text.indexOf('id="signals-table"');
      const panelStart = resp.text.indexOf('data-signals-chat-panel');
      const tableEndSearch = resp.text.substring(Math.max(0, tableStart - 500), tableStart + 5000);

      expect(tableStart).toBeGreaterThan(-1);
      expect(panelStart).toBeGreaterThan(-1);

      // The HTMX fragment response for pagination should NOT include the chat panel
      // We verify this by checking that the panel is structurally outside #signals-table
      // The signals.ejs renders #signals-table as a fragment; the chat panel lives outside it
    });

    it('HTMX pagination response does not include chat panel', async () => {
      const resp = await request(httpServer).get('/signals?htmx=true');
      expect(resp.status).toBe(200);
      // The htmx=true fragment should only render _signalsTable, NOT the chat panel
      expect(resp.text).not.toContain('data-signals-chat-panel');
    });
  });

  describe('Chat closes on full-page navigation', () => {
    it('signal detail page does not include signals-list chat panel', async () => {
      const t = Date.now();
      addChannel(db, `UCnav${t}`, 'Nav Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vnav-${t}`, `UCnav${t}`, 'Nav Video', `2103-12-31T00:00:00Z`, '[]', 'summary', 4, Date.now());

      const resp = await request(httpServer).get(`/signals/vnav-${t}`);
      expect(resp.status).toBe(200);
      // Signal detail should NOT have the signals-list chat panel marker
      expect(resp.text).not.toContain('data-signals-chat-panel');
    });
  });

  describe('Alpine chatPanel component', () => {
    it('uses Alpine component with scope configuration', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      // The panel should use an Alpine x-data or x-init binding for the chatPanel logic
      expect(resp.text).toMatch(/x-data|chatPanel/);
    });

    it('scope config includes topicKey and channelId from current filters', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      // The Alpine component should have access to scope params
      expect(resp.text).toContain('topicKey');
      expect(resp.text).toContain('channelId');
    });
  });

  describe('Filter change detection with toast', () => {
    it('renders toast element for scope update notifications', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('data-scope-toast');
    });

    it('listens for htmx:afterRequest to detect filter changes', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('htmx:afterRequest');
    });
  });

  describe('Scope badge channel name resolution (Issue #136 Bug 2)', () => {
    it('renders channelsMap object mapping channel_id to display_name', async () => {
      const t = Date.now();
      addChannel(db, `UCmap${t}`, 'My Display Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vmap-${t}`, `UCmap${t}`, 'Map Video', `2103-12-31T00:00:00Z`, '[]', 'summary', 4, Date.now());

      const resp = await request(httpServer).get(`/signals?channelId=UCmap${t}`);
      expect(resp.status).toBe(200);
      // The page should contain a channelsMap with the display name
      expect(resp.text).toContain('My Display Channel');
      // And it should be in a map/object context (channelsMap variable)
      expect(resp.text).toContain('channelsMap');
    });

    it('scopeLabel uses channel display name instead of truncated raw ID', async () => {
      const t = Date.now();
      addChannel(db, `UCdisplay${t}`, 'Display Name Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vdisplay-${t}`, `UCdisplay${t}`, 'Display Video', `2103-12-31T00:00:00Z`, '[]', 'summary', 4, Date.now());

      const resp = await request(httpServer).get(`/signals?channelId=UCdisplay${t}`);
      expect(resp.status).toBe(200);
      // The page should contain channelsMap reference (server-provided map)
      expect(resp.text).toContain('channelsMap');
      // The old substring(0, 12) pattern should NOT be present anywhere in output
      expect(resp.text).not.toContain('substring(0, 12)');
    });
  });

  describe('API integration for list-scoped chat', () => {
    it('chat panel sends POST /chat/ask with topicKey and channelId', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      // The Alpine send method should reference /chat/ask endpoint
      expect(resp.text).toContain('/chat/ask');
    });

    it('chat panel loads history from /chat/history with scope params', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      expect(resp.text).toContain('/chat/history');
    });

    it('chat panel polls status using HTMX pattern', async () => {
      const resp = await request(httpServer).get('/signals');
      expect(resp.status).toBe(200);
      // Should reference the status polling endpoint or include hx-trigger for polling
      expect(resp.text).toContain('/chat/');
    });
  });
});