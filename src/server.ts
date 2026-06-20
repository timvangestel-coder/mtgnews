import express, { Express } from 'express';
import layouts from 'express-ejs-layouts';
import path from 'path';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { db } from './index';
import { recoverStaleRuns, startScheduledPolling } from './scheduler';
import { SignalQueryService } from './services/signal-query-service';
import { createSignalsRouter } from './routes/signals-router';
import { ChannelManager } from './services/channel-manager';
import { createAdminChannelsRouter } from './routes/admin-channels-router';
import { TopicManager } from './services/topic-manager';
import { createAdminTopicsRouter } from './routes/admin-topics-router';
import { PollQueryService } from './services/poll-query-service';
import { createPollsRouter } from './routes/polls-router';
import { PollRunManager } from './poll-run-manager';
import { createAdminPollingRouter } from './routes/admin-polling-router';
import { createAdminRouter } from './routes/admin-router';
import { createAdminSettingsRouter } from './routes/admin-settings-router';
import { ChatManager } from './services/chat-manager';
import { ChatQueue } from './chat-queue';
import { ConcurrencyPool } from './concurrency-pool';
import { getLlmConfig } from './llm';
import { createChatRouter } from './routes/chat-router';

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

  // static — serve client-side scripts from views/scripts/
  app.use('/scripts', express.static(path.join(__dirname, '..', 'views', 'scripts')));

  // body parsers
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Recover stale runs from previous startup (blocking, DB-only)
  const recovered = recoverStaleRuns(useDb);
  if (recovered > 0) {
    console.log(`[scheduler] Recovered ${recovered} stale run(s) on startup`);
  }

  // Global concurrency pool shared between Poll analysis and Chat processing
  const llmConcurrency = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
  const globalPool = new ConcurrencyPool(llmConcurrency);

  // PollRunManager — consolidated poll lifecycle manager (Issue #78)
  const pollRunManager = new PollRunManager(useDb, globalPool);

  // start background worker (opt-out for tests)
  if (opts.startScheduler !== false) {
    startScheduledPolling(pollRunManager);
  }

  // redirect root
  app.get('/', (_req, res) => res.redirect('/signals'));

  // signals — mounted via router (Issue #67)
  const signalService = new SignalQueryService(useDb);
  app.use('/', createSignalsRouter(signalService));

  // admin channels — mounted via router (Issue #68)
  const channelManager = new ChannelManager(useDb);
  app.use('/', createAdminChannelsRouter(channelManager));

  // admin topics — mounted via router (Issue #69)
  const topicManager = new TopicManager(useDb);
  app.use('/', createAdminTopicsRouter(topicManager));

  // polls — mounted via router (Issue #71)
  const pollQueryService = new PollQueryService(useDb);
  app.use('/', createPollsRouter(pollQueryService, pollRunManager));

  // admin polling — mounted via router (Issue #70)
  app.use('/', createAdminPollingRouter(pollRunManager));

  // admin settings — mounted via router (Issue #103)
  app.use('/', createAdminSettingsRouter(useDb));

  // admin dashboard — mounted via router (Issue #72)
  app.use('/', createAdminRouter(channelManager, topicManager, pollRunManager, useDb));

  // chat — mounted via router with queue (Issue #108, #120)
  const chatManager = new ChatManager(useDb, getLlmConfig());
  const chatQueue = new ChatQueue(useDb, chatManager, globalPool);
  app.use('/', createChatRouter(chatManager, chatQueue));

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