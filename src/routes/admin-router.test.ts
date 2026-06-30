import supertest from 'supertest';
import express from 'express';
import layouts from 'express-ejs-layouts';
import { createAdminRouter } from './admin-router';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollRunManager } from '../poll-run-manager';
import path from 'path';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';

function createTestApp() {
  const db = new Database(':memory:');
  initDb(db);

  const channelManager = new ChannelManager(db);
  const topicManager = new TopicManager(db);
  const pollRunManager = new PollRunManager(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(layouts);
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', createAdminRouter(channelManager, topicManager, pollRunManager, db));

  return { app, db };
}

describe('admin-router', () => {
  describe('GET /admin', () => {
    it('renders admin page with channels, topics, and no current run', async () => {
      const { app, db } = createTestApp();

      // Insert a channel
      db.prepare("INSERT INTO channels (channel_id, display_name, active, added_at) VALUES ('uc123', 'Test Channel', 1, ?)").run(Date.now());
      // Insert a topic
      db.prepare("INSERT INTO topics (key, short_name, filter_text) VALUES ('tech', 'Tech', '*.tech')").run();

      const response = await supertest(app).get('/admin');

      expect(response.status).toBe(200);
    });

    it('renders admin page with current running poll', async () => {
      const { app, db } = createTestApp();

      // Insert a running poll run
      db.prepare("INSERT INTO poll_runs (triggered_at, status, new_signal_count) VALUES (?, 'running', 0)").run(Date.now());

      const response = await supertest(app).get('/admin');

      expect(response.status).toBe(200);
    });

    it('accepts tab query parameter', async () => {
      const { app } = createTestApp();

      const response = await supertest(app).get('/admin?tab=channels');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /admin/undo-all', () => {
    it('sends HX-Trigger header with refreshData and refreshChannels', async () => {
      const { app } = createTestApp();

      const response = await supertest(app)
        .post('/admin/undo-all')
        .set('Content-Type', 'application/x-www-form-urlencoded');

      expect(response.status).toBe(200);
      const triggerHeader = response.headers['hx-trigger'];
      expect(triggerHeader).toBeDefined();

      const triggers = JSON.parse(triggerHeader!);
      expect(triggers.refreshData).toBeDefined();
      expect(triggers.refreshChannels).toBeDefined();
    });
  });

  describe('POST /admin/purge-all', () => {
    it('sends HX-Trigger header with refreshData and refreshChannels', async () => {
      const { app } = createTestApp();

      const response = await supertest(app)
        .post('/admin/purge-all')
        .set('Content-Type', 'application/x-www-form-urlencoded');

      expect(response.status).toBe(200);
      const triggerHeader = response.headers['hx-trigger'];
      expect(triggerHeader).toBeDefined();

      const triggers = JSON.parse(triggerHeader!);
      expect(triggers.refreshData).toBeDefined();
      expect(triggers.refreshChannels).toBeDefined();
    });
  });
});
