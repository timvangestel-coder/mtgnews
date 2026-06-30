import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { createTopic } from '../db/watchlist';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { createAdminChannelsRouter } from './admin-channels-router';

// Mock rss-discovery so addChannelWithInfo doesn't make real HTTP calls
vi.mock('../rss-discovery', () => ({
  resolveChannelId: vi.fn((input: string) => Promise.resolve(input)),
  fetchChannelInfo: vi.fn(() => Promise.resolve(null)),
}));

let db: Database.Database;

function buildApp(channelManager: ChannelManager, topicManager: TopicManager) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  a.set('view engine', 'ejs');
  a.set('views', ['views/admin', 'views']);
  a.use(createAdminChannelsRouter(channelManager, topicManager));
  return a;
}

describe('admin-channels-router', () => {
  describe('POST /admin/channels/add', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      createTopic(db, 'test-topic', 'Test', '');
      const channelManager = new ChannelManager(db);
      const topicManager = new TopicManager(db);
      const app = buildApp(channelManager, topicManager);

      // Expose app for tests
      (global as any).__testApp = app;
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request((global as any).__testApp)
        .post('/admin/channels/add')
        .send({});

      expect(res.status).toBe(400);
    });

    it('sends HX-Trigger refreshChannels and renders fragment for HTMX requests', async () => {
      const res = await request((global as any).__testApp)
        .post('/admin/channels/add')
        .set('HX-Request', 'true')
        .send({ channel_id: '@testhandle' });

      expect(res.status).toBe(200);
      // Must NOT use HX-Redirect (full page reload)
      expect(res.header['hx-redirect']).toBeUndefined();
      // Must send HX-Trigger so client re-fetches the channels fragment
      const trigger = JSON.parse(res.header['hx-trigger'] as string);
      expect(trigger.refreshChannels).toEqual({});
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request((global as any).__testApp)
        .post('/admin/channels/add')
        .send({ channel_id: '@testhandle2' });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
    });

    it('passes topic_id to service when provided', async () => {
      const res = await request((global as any).__testApp)
        .post('/admin/channels/add')
        .set('HX-Request', 'true')
        .send({ channel_id: '@withtopic', topic_id: '1' });

      expect(res.status).toBe(200);
      const trigger = JSON.parse(res.header['hx-trigger'] as string);
      expect(trigger.refreshChannels).toEqual({});
    });
  });

  describe('POST /admin/channels/remove', () => {
    let testApp: express.Express;

    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      const channelManager = new ChannelManager(db);
      const topicManager = new TopicManager(db);
      testApp = buildApp(channelManager, topicManager);
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(testApp)
        .post('/admin/channels/remove')
        .send({});

      expect(res.status).toBe(400);
    });

    it('sends HX-Trigger refreshChannels and renders fragment for HTMX requests', async () => {
      const res = await request(testApp)
        .post('/admin/channels/remove')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCsome123' });

      expect(res.status).toBe(200);
      // Must NOT use HX-Redirect (full page reload)
      expect(res.header['hx-redirect']).toBeUndefined();
      // Must send HX-Trigger so client re-fetches the channels fragment
      const trigger = JSON.parse(res.header['hx-trigger'] as string);
      expect(trigger.refreshChannels).toEqual({});
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(testApp)
        .post('/admin/channels/remove')
        .send({ channel_id: 'UCsome123' });

      expect(res.status).toBe(302);
    });
  });

  describe('POST /admin/channels/toggle', () => {
    let testApp: express.Express;

    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      const channelManager = new ChannelManager(db);
      const topicManager = new TopicManager(db);
      testApp = buildApp(channelManager, topicManager);
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(testApp)
        .post('/admin/channels/toggle')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 200 with HX-Redirect for HTMX requests on success (no regression)', async () => {
      const res = await request(testApp)
        .post('/admin/channels/toggle')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCtoggle123', active: 'true' });

      expect(res.status).toBe(200);
      expect(res.header['hx-redirect']).toBe('/admin?tab=channels');
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(testApp)
        .post('/admin/channels/toggle')
        .send({ channel_id: 'UCtoggle123', active: 'false' });

      expect(res.status).toBe(302);
    });
  });

  describe('POST /admin/channels/update-topic', () => {
    let testApp: express.Express;

    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      createTopic(db, 'test-topic-2', 'Test 2', '');
      const channelManager = new ChannelManager(db);
      const topicManager = new TopicManager(db);
      testApp = buildApp(channelManager, topicManager);
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when channel_id missing', async () => {
      const res = await request(testApp)
        .post('/admin/channels/update-topic')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 200 with HX-Redirect for HTMX requests on success (no regression)', async () => {
      const res = await request(testApp)
        .post('/admin/channels/update-topic')
        .set('HX-Request', 'true')
        .send({ channel_id: 'UCtopic123', topic_id: '1' });

      expect(res.status).toBe(200);
      expect(res.header['hx-redirect']).toBe('/admin?tab=channels');
    });

    it('redirects for non-HTMX requests on success', async () => {
      const res = await request(testApp)
        .post('/admin/channels/update-topic')
        .send({ channel_id: 'UCtopic123' });

      expect(res.status).toBe(302);
    });
  });
});