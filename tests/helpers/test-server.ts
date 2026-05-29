import Database from 'better-sqlite3';
import express, { Express } from 'express';
import layouts from 'express-ejs-layouts';
import path from 'path';
import { initDb } from '../../src/db/init-db';

/**
 * Create an isolated in-memory SQLite database with schema initialized.
 * Caller is responsible for calling db.close() when done.
 */
export function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  initDb(testDb);
  return testDb;
}

/**
 * Create an Express app configured with view engine, middleware, and the given router mounted.
 * Scheduler is disabled (startScheduler: false) for test isolation.
 */
export function createTestApp(
  router: express.Router,
  options?: { port?: number },
): Express {
  const app: Express = express();

  // view engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'views'));
  app.use(layouts);
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);

  // middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // root redirect
  app.get('/', (_req, res) => res.redirect('/signals'));

  // mount the provided router
  app.use('/', router);

  return app;
}