import { Router } from 'express';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollTriggerService } from '../services/poll-trigger-service';

export function createAdminRouter(
  channelManager: ChannelManager,
  topicManager: TopicManager,
  pollTriggerService: PollTriggerService,
) {
  const router = Router();

  // GET /admin — admin dashboard
  router.get('/admin', (req, res) => {
    const channels = channelManager.listAll();
    const topics = topicManager.listWithCounts();

    const progressResult = pollTriggerService.currentProgress();
    const currentRun = progressResult?.run?.status === 'running' ? progressResult.run : null;
    const currentProgress = currentRun ? progressResult.progress : [];

    const tab = req.query.tab as string | undefined;

    res.render('admin', {
      activePage: 'admin',
      title: 'Admin Panel',
      channels,
      topics,
      currentRun,
      currentProgress,
      tab,
    });
  });

  return router;
}