import { Router } from 'express';
import Database from 'better-sqlite3';
import { getAppSetting } from '../db/app-settings';
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

    // Use RunState view model for rich progress data
    const progressResult = pollRunManager.currentProgress();
    let currentRunState = null;
    if (progressResult && progressResult.run.status === 'running') {
      currentRunState = pollRunManager.runState(progressResult.run.id);
    }

    const tab = req.query.tab as string | undefined;

    const defaultPrompt = getAppSetting(db, 'default_summary_prompt');

    res.render('admin', {
      activePage: 'admin',
      title: 'Admin Panel',
      channels,
      topics,
      currentRunState,
      tab,
      defaultPrompt,
    });
  });

  return router;
}
