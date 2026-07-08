import { Router } from 'express';
import Database from 'better-sqlite3';
import { getAppSetting } from '../db/app-settings';
import { getDbWideSoftDeleteCounts, undoAllSoftDeletes, purgeAllSoftDeleted } from '../db/cascade-delete';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollRunManager } from '../poll-run-manager';
import { queryPollRuns } from '../db/poll-runs';

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

    // Soft delete counts for Settings tab (server-rendered, zero extra HTTP requests)
    const softDeleteCounts = getDbWideSoftDeleteCounts(db);
    const softDeleteTotal =
      softDeleteCounts.channels +
      softDeleteCounts.signals +
      softDeleteCounts.mentions +
      softDeleteCounts.chats +
      softDeleteCounts.progress;

    // Overview counts for the Overview tab initial render
    const activeChannelCount = channels.filter((c) => c.active && c.topic_id != null).length;
    const signalCounts = db
      .prepare(
        `SELECT
          COUNT(*) FILTER (WHERE processing_state = 'summarized') AS summarized,
          COUNT(*) FILTER (WHERE processing_state = 'pending') AS pending
         FROM signals WHERE deleted_at IS NULL`
      )
      .get() as { summarized: number; pending: number };
    const overviewCounts = {
      channels: activeChannelCount,
      topics: topics.length,
      summarized: signalCounts?.summarized ?? 0,
      pending: signalCounts?.pending ?? 0,
    };
    const { items: recentRuns } = queryPollRuns(db, { limit: 5 });

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
      overviewCounts,
      recentRuns,
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

    // Signal both Settings and Channels tab wrappers to re-fetch their fragments
    res.set('HX-Trigger', JSON.stringify({ refreshSettings: {}, refreshChannels: {} }));

    // layout: false prevents express-ejs-layouts from wrapping in layout.ejs (which requires activePage)
    res.render('admin/_settingsTab', {
      layout: false,
      defaultPrompt: getAppSetting(db, 'default_summary_prompt'),
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

    // Signal both Settings and Channels tab wrappers to re-fetch their fragments
    res.set('HX-Trigger', JSON.stringify({ refreshSettings: {}, refreshChannels: {} }));

    // layout: false prevents express-ejs-layouts from wrapping in layout.ejs (which requires activePage)
    res.render('admin/_settingsTab', {
      layout: false,
      defaultPrompt: getAppSetting(db, 'default_summary_prompt'),
      softDeleteCounts: freshCounts,
      softDeleteTotal: freshTotal,
    });
  });

  return router;
}