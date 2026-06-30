import request from 'supertest';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { createTopic as dbCreateTopic, listTopics, getTopicById, addChannel } from '../db/watchlist';
import { TopicManager } from '../services/topic-manager';
import { createAdminTopicsRouter } from './admin-topics-router';

let db: Database.Database;
let app: express.Express;

function setupApp(manager: TopicManager) {
  const a = express();
  a.use(express.urlencoded({ extended: true }));
  a.use(express.json());
  // Set up views for HTMX row re-render tests
  a.set('view engine', 'ejs');
  a.set('views', 'views');
  a.use(createAdminTopicsRouter({ service: manager, db }));
  return a;
}

describe('admin-topics-router', () => {
  describe('POST /admin/topics', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new TopicManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when key is missing', async () => {
      const res = await request(app)
        .post('/admin/topics')
        .send({ short_name: 'No Key' });

      expect(res.status).toBe(400);
    });

    it('creates topic and returns 200 with HX-Trigger refreshTopics for HTMX requests', async () => {
      const t = Date.now();
      const res = await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `htmx-topic-${t}`, short_name: `HTMX Topic ${t}`, filter_text: 'test' });

      expect(res.status).toBe(200);
      const trigger = JSON.parse(res.header['hx-trigger'] as string);
      expect(trigger.refreshTopics).toBeDefined();

      const topics = listTopics(db);
      expect(topics.find((tp) => tp.key === `htmx-topic-${t}`)).toBeDefined();
    });

    it('redirects for non-HTMX requests on success', async () => {
      const t = Date.now();
      const res = await request(app)
        .post('/admin/topics')
        .send({ key: `redirect-topic-${t}`, short_name: `Redirect ${t}` });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
    });

    it('renders topics tab fragment on success for HTMX requests', async () => {
      const t = Date.now();
      const res = await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `fragment-topic-${t}`, short_name: `Fragment Topic ${t}`, filter_text: 'f' });

      expect(res.status).toBe(200);
      expect(res.text).toContain(`Fragment Topic ${t}`);
    });

    it('returns 400 for duplicate key', async () => {
      const t = Date.now();
      // Create first
      await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `dup-${t}`, short_name: 'First' });

      // Try duplicate
      const res = await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `dup-${t}`, short_name: 'Second' });

      expect(res.status).toBe(400);
      expect(res.text).toContain('Duplicate');
    });

    it('saves summary_prompt on create', async () => {
      const t = Date.now();
      const prompt = `Custom template ${t}`;
      const res = await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `prompt-create-${t}`, short_name: `Prompt Create ${t}`, filter_text: 'f', summary_prompt: prompt });

      expect(res.status).toBe(200);
      const found = listTopics(db).find((tp) => tp.key === `prompt-create-${t}`);
      expect(found!.summary_prompt).toBe(prompt);
    });

    it('saves NULL summary_prompt when field not provided', async () => {
      const t = Date.now();
      const res = await request(app)
        .post('/admin/topics')
        .set('HX-Request', 'true')
        .send({ key: `no-prompt-create-${t}`, short_name: `No Prompt ${t}` });

      expect(res.status).toBe(200);
      const found = listTopics(db).find((tp) => tp.key === `no-prompt-create-${t}`);
      expect(found!.summary_prompt).toBeNull();
    });
  });

  describe('POST /admin/topics/update', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new TopicManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when id is missing', async () => {
      const res = await request(app)
        .post('/admin/topics/update')
        .send({});

      expect(res.status).toBe(400);
    });

    it('updates topic and returns 200 with row HTML for HTMX requests', async () => {
      const t = Date.now();
      dbCreateTopic(db, `update-htmx-${t}`, 'Before Update', '');
      const topic = listTopics(db).find((tp) => tp.key === `update-htmx-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/update')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id), key: `updated-${t}`, short_name: 'After Update', filter_text: 'new' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('After Update');
      expect(res.text).toContain('data-topic-id');
    });

    it('redirects for non-HTMX requests on success', async () => {
      const t = Date.now();
      dbCreateTopic(db, `update-redirect-${t}`, 'Before', '');
      const topic = listTopics(db).find((tp) => tp.key === `update-redirect-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/update')
        .send({ id: String(topic.id), short_name: 'Changed' });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
    });

    it('includes channel_count in re-rendered row', async () => {
      const t = Date.now();
      dbCreateTopic(db, `count-row-${t}`, 'With Channels', '');
      const topic = listTopics(db).find((tp) => tp.key === `count-row-${t}`)!;
      addChannel(db, `UC_row_${t}`, 'Row Channel', undefined, topic.id);

      const res = await request(app)
        .post('/admin/topics/update')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id), short_name: 'Updated With Count' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('1');
    });

    it('updates summary_prompt via HTMX request', async () => {
      const t = Date.now();
      dbCreateTopic(db, `update-prompt-${t}`, 'Before Prompt', '');
      const topic = listTopics(db).find((tp) => tp.key === `update-prompt-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/update')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id), summary_prompt: 'Updated template' });

      expect(res.status).toBe(200);
      const updated = getTopicById(db, topic.id);
      expect(updated!.summary_prompt).toBe('Updated template');
    });

    it('sets summary_prompt to null when empty string sent', async () => {
      const t = Date.now();
      dbCreateTopic(db, `nullify-prompt-${t}`, 'Nullify Prompt', '', 'existing prompt');
      const topic = listTopics(db).find((tp) => tp.key === `nullify-prompt-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/update')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id), summary_prompt: '' });

      expect(res.status).toBe(200);
      const updated = getTopicById(db, topic.id);
      expect(updated!.summary_prompt).toBeNull();
    });
  });

  describe('POST /admin/topics/delete', () => {
    beforeAll(() => {
      db = new Database(':memory:');
      initDb(db);
      app = setupApp(new TopicManager(db));
    });

    afterAll(() => {
      db.close();
    });

    it('returns 400 when id is missing', async () => {
      const res = await request(app)
        .post('/admin/topics/delete')
        .send({});

      expect(res.status).toBe(400);
    });

    it('deletes topic and returns 200 with HX-Trigger refreshTopics for HTMX requests', async () => {
      const t = Date.now();
      dbCreateTopic(db, `del-htmx-${t}`, 'Delete Me', '');
      const topic = listTopics(db).find((tp) => tp.key === `del-htmx-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/delete')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id) });

      expect(res.status).toBe(200);
      const trigger = JSON.parse(res.header['hx-trigger'] as string);
      expect(trigger.refreshTopics).toBeDefined();

      const remaining = listTopics(db).find((tp) => tp.key === `del-htmx-${t}`);
      expect(remaining).toBeUndefined();
    });

    it('redirects for non-HTMX requests on success', async () => {
      const t = Date.now();
      dbCreateTopic(db, `del-redirect-${t}`, 'Delete Redirect', '');
      const topic = listTopics(db).find((tp) => tp.key === `del-redirect-${t}`)!;

      const res = await request(app)
        .post('/admin/topics/delete')
        .send({ id: String(topic.id) });

      expect(res.status).toBe(302);
      expect(res.header.location).toContain('/admin');
    });

    it('force-delete preserves channels with topic_id NULL', async () => {
      const t = Date.now();
      dbCreateTopic(db, `forcedel-route-${t}`, 'Force Del Route', '');
      const topic = listTopics(db).find((tp) => tp.key === `forcedel-route-${t}`)!;
      addChannel(db, `UC_forceroute_${t}`, 'Force Route Channel', undefined, topic.id);

      await request(app)
        .post('/admin/topics/delete')
        .set('HX-Request', 'true')
        .send({ id: String(topic.id) });

      // Topic deleted
      expect(listTopics(db).find((tp) => tp.key === `forcedel-route-${t}`)).toBeUndefined();

      // Channel preserved with NULL topic_id
      const ch = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get(`UC_forceroute_${t}`) as { topic_id: number | null };
      expect(ch.topic_id).toBeNull();
    });
  });
});