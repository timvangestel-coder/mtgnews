import supertest from 'supertest';
import express from 'express';
import layouts from 'express-ejs-layouts';
import { createAdminSettingsRouter } from './admin-settings-router';
import path from 'path';
import Database from 'better-sqlite3';
import { initDb } from '../db/init-db';
import { getAppSetting } from '../db/app-settings';

function createTestApp() {
  const db = new Database(':memory:');
  initDb(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(layouts);
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', createAdminSettingsRouter(db));

  return { app, db };
}

describe('admin-settings-router', () => {
  describe('POST /admin/settings/default-prompt', () => {
    it('saves a non-empty prompt to app_settings and redirects', async () => {
      const { app, db } = createTestApp();

      const response = await supertest(app)
        .post('/admin/settings/default-prompt')
        .type('form')
        .send({ prompt: 'My custom global prompt template' });

      expect(response.status).toBe(303);
      expect(getAppSetting(db, 'default_summary_prompt')).toBe('My custom global prompt template');
    });

    it('clears DB override when prompt is empty string', async () => {
      const { app, db } = createTestApp();

      // Seed a value first
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('default_summary_prompt', 'existing')").run();
      expect(getAppSetting(db, 'default_summary_prompt')).toBe('existing');

      const response = await supertest(app)
        .post('/admin/settings/default-prompt')
        .type('form')
        .send({ prompt: '' });

      expect(response.status).toBe(303);
      expect(getAppSetting(db, 'default_summary_prompt')).toBeNull();
    });

    it('redirects to /admin?tab=topics on success', async () => {
      const { app } = createTestApp();

      const response = await supertest(app)
        .post('/admin/settings/default-prompt')
        .type('form')
        .send({ prompt: 'test' });

      expect(response.header.location).toBe('/admin?tab=topics');
    });
  });
});