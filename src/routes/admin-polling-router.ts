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

  // POST /admin/poll/abort/:id — HTMX inline widget swap (no redirect)
  router.post('/admin/poll/abort/:id', async (req, res) => {
    const runId = parseInt(req.params.id, 10);

    try {
      await manager.abortRun(runId);
    } catch (err) {
      // Render progress widget with inline error banner using single progress() call
      const prog = manager.progress();
      if (prog) {
        res.render('admin/_pollProgress', {
          state: prog.state,
          signalPhases: prog.signalPhases,
          error: (err as Error).message,
          layout: false,
        });
        return;
      }
      // Fallback: render widget with no state and error message
      res.render('admin/_pollProgress', {
        state: null,
        signalPhases: [],
        error: (err as Error).message,
        layout: false,
      });
      return;
    }

    // Render progress widget inline with aborted state using single progress() call
    const prog = manager.progress();
    if (prog) {
      res.render('admin/_pollProgress', {
        state: prog.state,
        signalPhases: prog.signalPhases,
        layout: false,
      });
    } else {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
    }
  });

  // GET /admin/poll/progress
  router.get('/admin/poll/progress', (req, res) => {
    // Single progress() call replaces currentProgress() + runState() + getSignalPhases()
    const prog = manager.progress();
    if (!prog) {
      res.send('<p class="text-gray-500">No poll runs yet.</p>');
      return;
    }

    res.render('admin/_pollProgress', {
      state: prog.state,
      signalPhases: prog.signalPhases,
      layout: false,
    });
  });

  return router;
}
