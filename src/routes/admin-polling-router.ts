import { Router } from 'express';
import { PollRunManager } from '../poll-run-manager';

export function createAdminPollingRouter(manager: PollRunManager) {
  const router = Router();

  // POST /admin/poll/trigger — inline widget update (no redirect)
  router.post('/admin/poll/trigger', async (req, res) => {
    const raw = req.body.lookback_days;
    const lookbackDays = raw ? parseInt(raw as string, 10) : 2;

    // startRun handles enqueue, pre-register, and worker spawn internally
    const runId = await manager.startRun(lookbackDays);

    // Render progress widget inline using RunState view model
    const state = manager.runState(runId);
    if (state) {
      res.render('admin/_pollProgress', {
        state,
        layout: false,
      });
    } else {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
    }
  });

  // POST /admin/poll/abort/:id
  router.post('/admin/poll/abort/:id', async (req, res) => {
    const runId = parseInt(req.params.id, 10);
    const returnTo = req.query.return_to as string | undefined;

    try {
      await manager.abortRun(runId);
    } catch (err) {
      res.redirect(`${returnTo || '/admin'}?error=${encodeURIComponent((err as Error).message)}`);
      return;
    }

    res.redirect(returnTo || '/admin');
  });

  // GET /admin/poll/progress
  router.get('/admin/poll/progress', (req, res) => {
    // Get latest run id for polling endpoint
    const row = manager.currentProgress();
    if (!row) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    // Use RunState view model for rich data (phase, signalsAnalyzed, steps)
    const state = manager.runState(row.run.id);
    if (!state) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    res.render('admin/_pollProgress', {
      state,
      layout: false,
    });
  });

  return router;
}
