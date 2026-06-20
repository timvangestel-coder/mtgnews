import { Router } from 'express';
import { PollQueryService } from '../services/poll-query-service';
import { PollRunManager } from '../poll-run-manager';
import { stepDisplay } from '../utils/poll-run-view-model';

export function createPollsRouter(service: PollQueryService, manager?: PollRunManager) {
  const router = Router();

  // Register stepDisplay as an Express view helper via res.locals
  router.use((req, res, next) => {
    res.locals.stepDisplay = stepDisplay;
    next();
  });

  // GET /polls — run history list
  router.get('/polls', (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = 25;

    const result = service.listRuns(page, limit);
    const totalPages = Math.max(1, Math.ceil(result.total / limit));

    res.render('polls', {
      activePage: 'polls',
      title: 'Run History',
      runs: result.items,
      page,
      totalPages,
      total: result.total,
    });
  });

  // GET /polls/:id-detail — run detail
  router.get('/polls/:id-detail', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const detail = service.getRunDetail(id);
    if (!detail) {
      res.status(404).send('Poll run not found');
      return;
    }

    // Include per-signal phase data for running runs (live in-memory data from manager)
    const signalPhases = manager ? manager.getSignalPhases() : [];

    res.render('poll-detail', {
      activePage: 'polls',
      title: `Run #${id} Detail`,
      run: detail.run,
      progress: detail.progress,
      state: detail.state,
      signalPhases,
    });
  });

  // GET /polls/:id/progress — per-run progress fragment for HTMX polling
  router.get('/polls/:id/progress', (req, res) => {
    const runId = parseInt(req.params.id, 10);
    const state = service.getRunState(runId);

    // Include per-signal phase data for running runs (live in-memory data from manager)
    const signalPhases = manager ? manager.getSignalPhases() : [];

    const progressUrl = `/polls/${runId}/progress`;

    res.render('admin/_pollProgress', {
      layout: false,
      state,
      signalPhases,
      progressUrl,
    });
  });

  return router;
}
