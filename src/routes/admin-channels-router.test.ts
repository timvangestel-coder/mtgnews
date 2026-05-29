import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { listChannels, createTopic } from '../db/watchlist';
import { ChannelManager } from '../services/channel-manager';
import { createAdminChannelsRouter } from './admin-channels-router';

// Mock rss-discovery so addChannelWithInfo doesn't make real HTTP calls
vi.mock('../rss-discovery', () => ({
  resolveChannelId: vi.fn((input: string) => Promise.resolve(input)),
  fetchChannelInfo: vi.fn(() => Promise.resolve(null)),
}));

let db: Database.Database;
let app: express.Express;

function setupApp(manager: ChannelManager) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.use(createAdminChannelsRouter(manager));
  return a;
}

describe('admin-channels-router', () => {
  describe('POST /admin/channels/add', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      createTopic(db, 'test-topic', 'Test', '');
      app = setupApp(new ChannelManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(app)
        .post('/admin/channels/add')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 204 for HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/add')
        .set('HX-Request', 'true')
        .send({ channel_id: '@testhandle' });

      expect(res.status).toBe(204);
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/add')
        .send({ channel_id: '@testhandle2' });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
    });

    it('passes topic_id to service when provided', async () => {
      const res = await request(app)
        .post('/admin/channels/add')
        .set('HX-Request', 'true')
        .send({ channel_id: '@withtopic', topic_id: '1' });

      expect(res.status).toBe(204);
    });
  });

  describe('POST /admin/channels/remove', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new ChannelManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(app)
        .post('/admin/channels/remove')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 204 for HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/remove')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCsome123' });

      expect(res.status).toBe(204);
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/remove')
        .send({ channel_id: 'UCsome123' });

      expect(res.status).toBe(302);
    });
  });

  describe('POST /admin/channels/toggle', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new ChannelManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(app)
        .post('/admin/channels/toggle')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 204 for HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/toggle')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCtoggle123', active: 'true' });

      expect(res.status).toBe(204);
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/toggle')
        .send({ channel_id: 'UCtoggle123', active: 'false' });

      expect(res.status).toBe(302);
    });
  });

  describe('POST /admin/channels/update-topic', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      createTopic(db, 'test-topic-2', 'Test 2', '');
      app = setupApp(new ChannelManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(app)
        .post('/admin/channels/update-topic')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 204 for HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/update-topic')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCtopic123', topic_id: '1' });

      expect(res.status).toBe(204);
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(app)
        .post('/admin/channels/update-topic')
        .send({ channel_id: 'UCtopic123' });

      expect(res.status).toBe(302);
    });
  });
});