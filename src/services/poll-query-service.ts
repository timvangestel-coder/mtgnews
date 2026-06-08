import Database from 'better-sqlite3';
import { queryPollRuns, getPollRunById, queryPollRunProgress, PollRunRow, PollRunProgressRow } from '../db/poll-runs';
import { mapStatus, mapStepStatus, type RunState, type PollRunStep } from '../utils/poll-run-view-model';

export interface ListRunsResult {
  items: PollRunRow[];
  total: number;
}

export interface RunDetailResult {
  run: PollRunRow;
  progress: PollRunProgressRow[];
  state: RunState;
}

export class PollQueryService {
  constructor(private db: Database.Database) {}

  listRuns(page: number = 1, limit: number = 25): ListRunsResult {
    const offset = (page - 1) * limit;
    return queryPollRuns(this.db, { limit, offset });
  }

  getRunState(runId: number): RunState | null {
    const run = getPollRunById(this.db, runId);
    if (!run) {
      return null;
    }

    const progress = queryPollRunProgress(this.db, runId);
    const steps: PollRunStep[] = progress.map((p) => ({
      displayName: p.display_name,
      status: mapStepStatus(p.status),
      total: p.signals_found,
      done: p.signalsDone,
    }));

    return {
      id: run.id,
      status: mapStatus(run.status),
      steps,
    };
  }

  getRunDetail(runId: number): RunDetailResult | null {
    const run = getPollRunById(this.db, runId);
    if (!run) {
      return null;
    }
    const progress = queryPollRunProgress(this.db, runId);
    const state = this.getRunState(runId)!;
    return { run, progress, state };
  }
}
