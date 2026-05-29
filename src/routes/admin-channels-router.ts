import { Router } from 'express';
import { ChannelManager } from '../services/channel-manager';
import { htmxNoContent } from '../utils/htmx-response';

export function createAdminChannelsRouter(service: ChannelManager) {
  const router = Router();

  // POST /admin/channels/add
  router.post('/admin/channels/add', async (req, res) => {
    const rawInput = req.body.channel_id as string;
    if (!rawInput) {
      res.status(400).send('channel_id required');
      return;
    }

    const topicId = req.body.topic_id ? parseInt(req.body.topic_id as string, 10) : null;
    await service.addChannelWithInfo(rawInput, topicId);
    htmxNoContent(req, res, '/admin?tab=channels');
  });

  // POST /admin/channels/remove
  router.post('/admin/channels/remove', (req, res) => {
    const channelId = req.body.channel_id as string;
    if (!channelId) {
      res.status(400).send('channel_id required');
      return;
    }
    service.removeChannel(channelId);
    htmxNoContent(req, res, '/admin?tab=channels');
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

  return router;
}