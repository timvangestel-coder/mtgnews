import { Router } from 'express';
import Database from 'better-sqlite3';
import { getAppSetting } from '../db/app-settings';
import { getDbWideSoftDeleteCounts, undoAllSoftDeletes, purgeAllSoftDeleted } from '../db/cascade-delete';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollRunManager } from '../poll-run-manager';

export function createAdminRouter(
  channelManager: ChannelManager,
  topicManager: TopicManager,
  pollRunManager: PollRunManager,
  db: Database.Database,
) {
  const router = Router();

  // GET /admin — admin dashboard
  router.get('/admin', (req, res) => {
    const channels = channelManager.listAll();
    const topics = topicManager.listWithCounts();

    // Use deep progress() method for composed view model
    const prog = pollRunManager.progress();
    let currentRunState = null;
    if (prog && prog.state.status === 'running') {
      currentRunState = prog.state;
    }

    const tab = req.query.tab as string | undefined;

    const defaultPrompt = getAppSetting(db, 'default_summary_prompt');

    // Soft delete counts for Data tab (server-rendered, zero extra HTTP requests)
    const softDeleteCounts = getDbWideSoftDeleteCounts(db);
    const softDeleteTotal =
      softDeleteCounts.channels +
      softDeleteCounts.signals +
      softDeleteCounts.mentions +
      softDeleteCounts.chats +
      softDeleteCounts.progress;

    res.render('admin', {
      activePage: 'admin',
      title: 'Admin Panel',
      channels,
      topics,
      currentRunState,
      tab,
      defaultPrompt,
      softDeleteCounts,
      softDeleteTotal,
    });
  });

  // GET /admin/data-fragment — renders _dataTab.ejs partial for HTMX swap
  router.get('/admin/data-fragment', (_req, res) => {
    const counts = getDbWideSoftDeleteCounts(db);
    const total = counts.channels + counts.signals + counts.mentions + counts.chats + counts.progress;
    // layout: false prevents express-ejs-layouts from wrapping in layout.ejs (which requires activePage)
    res.render('admin/_dataTab', {
      layout: false,
      softDeleteCounts: counts,
      softDeleteTotal: total,
    });
  });

  // POST /admin/undo-all — reset all soft deletes, return fresh data fragment
  router.post('/admin/undo-all', (_req, res) => {
    const result = undoAllSoftDeletes(db);
    console.log(`[admin] Undo all: restored ${result.total} entities`, result);

    // After undo, all counts should be zero
    const freshCounts = getDbWideSoftDeleteCounts(db);
    const freshTotal =
      freshCounts.channels +
      freshCounts.signals +
      freshCounts.mentions +
      freshCounts.chats +
      freshCounts.progress;

    // Signal both Data and Channels tab wrappers to re-fetch their fragments
    res.set('HX-Trigger', JSON.stringify({ refreshData: {}, refreshChannels: {} }));

    // layout: false prevents express-ejs-layouts from wrapping in layout.ejs (which requires activePage)
    res.render('admin/_dataTab', {
      layout: false,
      softDeleteCounts: freshCounts,
      softDeleteTotal: freshTotal,
    });
  });

  // POST /admin/purge-all — permanently delete all soft-deleted rows, return fresh data fragment
  router.post('/admin/purge-all', (_req, res) => {
    const result = purgeAllSoftDeleted(db);
    console.log(`[admin] Purge all: permanently deleted ${result.total} entities`, result);

    // After purge, all counts should be zero
    const freshCounts = getDbWideSoftDeleteCounts(db);
    const freshTotal =
      freshCounts.channels +
      freshCounts.signals +
      freshCounts.mentions +
      freshCounts.chats +
      freshCounts.progress;

    // Signal both Data and Channels tab wrappers to re-fetch their fragments
    res.set('HX-Trigger', JSON.stringify({ refreshData: {}, refreshChannels: {} }));

    // layout: false prevents express-ejs-layouts from wrapping in layout.ejs (which requires activePage)
    res.render('admin/_dataTab', {
      layout: false,
      softDeleteCounts: freshCounts,
      softDeleteTotal: freshTotal,
    });
  });

  return router;
}