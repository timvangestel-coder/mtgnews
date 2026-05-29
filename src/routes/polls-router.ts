import { Router } from 'express';
import { PollQueryService } from '../services/poll-query-service';

export function createPollsRouter(service: PollQueryService) {
  const router = Router();

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

    res.render('poll-detail', {
      activePage: 'polls',
      title: `Run #${id} Detail`,
      run: detail.run,
      progress: detail.progress,
    });
  });

  return router;
}