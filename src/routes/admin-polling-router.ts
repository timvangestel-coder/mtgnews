import { Router } from 'express';
import { PollTriggerService } from '../services/poll-trigger-service';
import { registerRun } from '../poll-scheduler';
import { htmxNoContent } from '../utils/htmx-response';

export function createAdminPollingRouter(service: PollTriggerService) {
  const router = Router();

  // POST /admin/poll/trigger
  router.post('/admin/poll/trigger', (req, res) => {
    const raw = req.body.lookback_days;
    const lookbackDays = raw ? parseInt(raw as string, 10) : 2;
    const runId = service.enqueueRun(lookbackDays);

    // Spawn poll worker in background (non-blocking)
    const controller = new AbortController();
    import('../poll-worker').then(({ workerProcessRun }) => {
      const worker = workerProcessRun(service.database, runId, { signal: controller.signal }).catch(console.error);
      registerRun(runId, controller, worker);
    });

    htmxNoContent(req, res, '/admin?tab=polling');
  });

  // POST /admin/poll/abort/:id
  router.post('/admin/poll/abort/:id', (req, res) => {
    const runId = parseInt(req.params.id, 10);
    const returnTo = req.query.return_to as string | undefined;

    try {
      service.abortRun(runId);
    } catch (err) {
      res.redirect(`${returnTo || '/admin'}?error=${encodeURIComponent((err as Error).message)}`);
      return;
    }

    res.redirect(returnTo || '/admin');
  });

  // GET /admin/poll/progress
  router.get('/admin/poll/progress', (req, res) => {
    const result = service.currentProgress();
    if (!result) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    res.render('admin/_pollProgress', {
      run: result.run,
      progress: result.progress,
      layout: false,
    });
  });

  return router;
}
