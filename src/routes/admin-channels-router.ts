import { Router } from 'express';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { htmxNoContent } from '../utils/htmx-response';

export function createAdminChannelsRouter(service: ChannelManager, topicManager: TopicManager) {
  const router = Router();

  // POST /admin/channels/add — fragment refresh (no full page reload)
  router.post('/admin/channels/add', async (req, res) => {
    const rawInput = req.body.channel_id as string;
    if (!rawInput) {
      res.status(400).send('channel_id required');
      return;
    }

    const topicId = req.body.topic_id ? parseInt(req.body.topic_id as string, 10) : null;
    await service.addChannelWithInfo(rawInput, topicId);

    if (req.headers['hx-request'] === 'true') {
      const fresh = service.listAll();
      const freshTopics = topicManager.listWithCounts();
      res.set('HX-Trigger', JSON.stringify({ refreshChannels: {} }));
      res.render('admin/_channelsTab', { layout: false, channels: fresh, topics: freshTopics });
    } else {
      res.redirect('/admin?tab=channels');
    }
  });

  // POST /admin/channels/remove — fragment refresh (no full page reload)
  router.post('/admin/channels/remove', (req, res) => {
    const channelId = req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    service.removeChannel(channelId);

    if (req.headers['hx-request'] === 'true') {
      const fresh = service.listAll();
      const freshTopics = topicManager.listWithCounts();
      // Refresh both Channels tab (removed row) and Data tab (soft delete count changed)
      res.set('HX-Trigger', JSON.stringify({ refreshChannels: {}, refreshData: {} }));
      res.render('admin/_channelsTab', { layout: false, channels: fresh, topics: freshTopics });
    } else {
      res.redirect('/admin?tab=channels');
    }
  });

  // POST /admin/channels/toggle
  router.post('/admin/channels/toggle', (req, res) => {
    const channelId = req.body.channel_id as string;
    const active = req.body.active === 'true';
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    service.toggleActive(channelId, active);
    htmxNoContent(req, res, '/admin?tab=channels');
  });

  // POST /admin/channels/update-topic
  router.post('/admin/channels/update-topic', (req, res) => {
    const channelId = req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    const topicId = req.body.topic_id ? parseInt(req.body.topic_id as string, 10) : null;
    service.updateTopic(channelId, topicId);
    htmxNoContent(req, res, '/admin?tab=channels');
  });

  // GET /admin/channels/delete-counts
  router.get('/admin/channels/delete-counts', (req, res) => {
    const channelId = req.query.channel_id as string;
    if (!channelId) {
      res.status(400).json({ error: 'channel_id query parameter required' });
      return;
    }
    const counts = service.getSoftDeleteCounts(channelId);
    res.json(counts);
  });

  return router;
}
