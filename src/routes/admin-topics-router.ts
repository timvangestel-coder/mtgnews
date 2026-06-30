import { Router } from 'express';
import Database from 'better-sqlite3';
import { TopicManager } from '../services/topic-manager';
import { UpdateTopicOptions } from '../db/watchlist';
import { getAppSetting } from '../db/app-settings';
import { htmxNoContent } from '../utils/htmx-response';

export interface AdminTopicsDeps {
  service: TopicManager;
  db: Database.Database;
}

export function createAdminTopicsRouter(deps: AdminTopicsDeps) {
  const { service, db } = deps;
  const router = Router();

  // POST /admin/topics — create
  router.post('/admin/topics', (req, res) => {
    const key = req.body.key as string;
    const shortName = req.body.short_name as string;
    const filterText = req.body.filter_text as string;
    const summaryPrompt = req.body.summary_prompt as string | undefined;
    const multiSignalSummaryPrompt = req.body.multi_signal_summary_prompt as string | undefined;

    if (!key) {
      res.status(400).send('key required');
      return;
    }

    try {
      service.create(key, shortName || '', filterText || '', summaryPrompt || null);
      // Issue #137: set multi_signal_summary_prompt if provided
      if (multiSignalSummaryPrompt) {
        const created = service.getByKey(key);
        if (created) {
          service.update(created.id, { multi_signal_summary_prompt: multiSignalSummaryPrompt });
        }
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('UNIQUE constraint failed') || msg.includes('duplicate key')) {
        res.status(400).send(`Duplicate key: ${key}`);
        return;
      }
      throw err;
    }

    // Issue #195: emit refreshTopics event + render fragment for HTMX requests
    if (req.headers['hx-request'] === 'true') {
      res.set('HX-Trigger', JSON.stringify({ refreshTopics: {} }));
      return res.render('admin/_topicsTab', {
        layout: false,
        topics: service.listWithCounts(),
        defaultPrompt: getAppSetting(db, 'default_summary_prompt'),
      });
    }

    htmxNoContent(req, res, '/admin?tab=topics');
  });

  // POST /admin/topics/update — update with HTMX row re-render
  router.post('/admin/topics/update', (req, res) => {
    const id = parseInt(req.body.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('id required');
      return;
    }

    const opts: UpdateTopicOptions = {};
    if (req.body.key !== undefined) opts.key = req.body.key as string;
    if (req.body.short_name !== undefined) opts.short_name = req.body.short_name as string;
    if (req.body.filter_text !== undefined) opts.filter_text = req.body.filter_text as string;
    if (req.body.summary_prompt !== undefined) opts.summary_prompt = req.body.summary_prompt as string || null;
    // Issue #137: support multi_signal_summary_prompt in updates
    if (req.body.multi_signal_summary_prompt !== undefined) opts.multi_signal_summary_prompt = req.body.multi_signal_summary_prompt as string || null;

    service.update(id, opts);

    // Issue #65: return re-rendered row HTML for HTMX requests
    if (req.headers['hx-request'] === 'true') {
      const updated = service.getTopicWithCount(id);
      if (updated) {
        return res.status(200).render('admin/_topicRow', { topic: updated, layout: false });
      }
    }

    htmxNoContent(req, res, '/admin?tab=topics');
  });

  // POST /admin/topics/delete — force-delete (nullifies channel topic_id)
  router.post('/admin/topics/delete', (req, res) => {
    const id = parseInt(req.body.id as string, 10);
    if (isNaN(id)) {
      res.status(400).send('id required');
      return;
    }

    service.delete(id);

    // Issue #195: emit refreshTopics event + render fragment for HTMX requests
    if (req.headers['hx-request'] === 'true') {
      res.set('HX-Trigger', JSON.stringify({ refreshTopics: {} }));
      return res.render('admin/_topicsTab', {
        layout: false,
        topics: service.listWithCounts(),
        defaultPrompt: getAppSetting(db, 'default_summary_prompt'),
      });
    }

    htmxNoContent(req, res, '/admin?tab=topics');
  });

  return router;
}
