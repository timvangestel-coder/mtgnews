import Database from 'better-sqlite3';
import { queryPollRuns, getPollRunById, queryPollRunProgress, PollRunRow, PollRunProgressRow } from '../db/poll-runs';

export interface ListRunsResult {
  items: PollRunRow[];
  total: number;
}

export interface RunDetailResult {
  run: PollRunRow;
  progress: PollRunProgressRow[];
}

export class PollQueryService {
  constructor(private db: Database.Database) {}

  listRuns(page: number = 1, limit: number = 25): ListRunsResult {
    const offset = (page - 1) * limit;
    return queryPollRuns(this.db, { limit, offset });
  }

  getRunDetail(runId: number): RunDetailResult | null {
    const run = getPollRunById(this.db, runId);
    if (!run) {
      return null;
    }
    const progress = queryPollRunProgress(this.db, runId);
    return { run, progress };
  }
}