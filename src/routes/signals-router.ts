import { Router, Request } from 'express';
import { displayTitleForSignal } from '../signal-detail';
import { SignalQueryService } from '../services/signal-query-service';
import { listTopics, getChannelsWithTopics } from '../db/watchlist';
import { computeDateRange } from '../scope-source';

interface RenderRequest extends Request {
  query: Record<string, string | string[] | undefined>;
}

export function createSignalsRouter(service: SignalQueryService) {
  const router = Router();

  // GET /signals — list signals (Signal Viewer)
  router.get('/signals', (req: RenderRequest, res) => {
    const channelId = req.query.channelId as string | undefined;
    const topicKey = req.query.topicKey as string | undefined;
    const showIrrelevant = req.query.showIrrelevant === 'true';
    const dateFilter = (req.query.dateFilter as string | undefined) || undefined;
    const page = parseInt(req.query.page as string, 10) || 1;
    const isHtmx = req.query.htmx === 'true';
    const limit = 25;
    const offset = (page - 1) * limit;

    // Issue #181: compute date range from filter preset
    const dateRange = computeDateRange(dateFilter);

    const result = service.listSignals({
      channelId,
      topicKey,
      includeIrrelevant: showIrrelevant,
      dateFrom: dateRange.from,
      limit,
      offset,
    });
    const channels = getChannelsWithTopics(service.database);
    const topics = listTopics(service.database);
    const totalPages = Math.ceil(result.total / limit);

    // Build a channel_id → display_name map for client-side scope badge resolution
    const channelsMap: Record<string, string> = {};
    for (const ch of channels) {
      channelsMap[ch.channel_id] = ch.display_name || ch.channel_id;
    }

    if (isHtmx) {
      res.render('_signalsTable', {
        signals: result.items,
        page,
        totalPages,
        total: result.total,
        channelId,
        topicKey,
        showIrrelevant,
        dateFilter,
        layout: false,
      });
    } else {
      res.render('signals', {
        activePage: 'signals',
        title: 'Signals',
        signals: result.items,
        channels,
        topics,
        page,
        totalPages,
        total: result.total,
        channelId,
        topicKey,
        showIrrelevant,
        dateFilter,
        channelsMap,
      });
    }
  });

  // GET /signals/:id — signal detail
  router.get('/signals/:id', (req, res) => {
    const detail = service.getSignalDetail(req.params.id);
    if (!detail) {
      res.status(404).send('Signal not found');
      return;
    }

    res.render('signal-detail', {
      activePage: 'signals',
      title: displayTitleForSignal(detail.signal),
      originalTitle: detail.signal.title,
      signal: detail.signal,
      channel: detail.channel,
      summaryHtml: detail.summaryHtml,
      transcriptionHtml: detail.transcriptionHtml,
      error: req.query.error as string | undefined,
    });
  });

  // POST /signals/:id/summarize
  router.post('/signals/:id/summarize', async (req, res) => {
    const videoId = req.params.id;
    const result = await service.summarizeSignal(videoId);
    if (!result.success) {
      res.redirect(`/signals/${videoId}?error=${encodeURIComponent(result.error || 'Summarization failed')}`);
    } else {
      res.redirect(`/signals/${videoId}`);
    }
  });

  return router;
}