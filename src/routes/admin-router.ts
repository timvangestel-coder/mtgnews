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

    // Use deep progress() method for composed view model
    const prog = pollRunManager.progress();
    let currentRunState = null;
    if (prog && prog.state.status === 'running') {
      currentRunState = prog.state;
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
