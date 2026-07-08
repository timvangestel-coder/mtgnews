import { Router } from 'express';
import Database from 'better-sqlite3';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollRunManager } from '../poll-run-manager';
import { getAppSetting } from '../db/app-settings';
import { getDbWideSoftDeleteCounts } from '../db/cascade-delete';
import { queryPollRuns } from '../db/poll-runs';

export interface AdminDeps {
  channelManager: ChannelManager;
  topicManager: TopicManager;
  pollRunManager: PollRunManager;
  db: Database.Database;
}

export interface TabFragment {
  key: string;
  partial: string;
  dataFn: (deps: AdminDeps) => Record<string, unknown>;
}

export const TABS: TabFragment[] = [
  {
    key: 'overview',
    partial: 'admin/_overviewTab',
    dataFn: ({ channelManager, topicManager, pollRunManager, db }) => {
      const allChannels = channelManager.listAll();
      const activeChannels = allChannels.filter((c) => c.active && c.topic_id != null).length;
      const topics = topicManager.listWithCounts();
      const signalCounts = db
        .prepare(
          `SELECT
            COUNT(*) FILTER (WHERE processing_state = 'summarized') AS summarized,
            COUNT(*) FILTER (WHERE processing_state = 'pending') AS pending
           FROM signals WHERE deleted_at IS NULL`
        )
        .get() as { summarized: number; pending: number };
      const { items: recentRuns } = queryPollRuns(db, { limit: 5 });
      const prog = pollRunManager.progress();
      const currentRunState = prog?.state.status === 'running' ? prog.state : null;
      return {
        counts: {
          channels: activeChannels,
          topics: topics.length,
          summarized: signalCounts?.summarized ?? 0,
          pending: signalCounts?.pending ?? 0,
        },
        recentRuns,
        currentRunState,
      };
    },
  },
  {
    key: 'channels',
    partial: 'admin/_channelsTab',
    dataFn: ({ channelManager, topicManager }) => ({
      channels: channelManager.listAll(),
      topics: topicManager.listWithCounts(),
    }),
  },
  {
    key: 'topics',
    partial: 'admin/_topicsTab',
    dataFn: ({ topicManager }) => ({
      topics: topicManager.listWithCounts(),
    }),
  },
  {
    key: 'settings',
    partial: 'admin/_settingsTab',
    dataFn: ({ db }) => {
      const defaultPrompt = getAppSetting(db, 'default_summary_prompt');
      const counts = getDbWideSoftDeleteCounts(db);
      const softDeleteTotal =
        counts.channels +
        counts.signals +
        counts.mentions +
        counts.chats +
        counts.progress;
      return { defaultPrompt, softDeleteCounts: counts, softDeleteTotal };
    },
  },
];

export function createFragmentRouter(deps: AdminDeps) {
  const router = Router();
  for (const tab of TABS) {
    router.get(`/admin/${tab.key}-fragment`, (_req, res) => {
      res.render(tab.partial, { layout: false, ...tab.dataFn(deps) });
    });
  }
  return router;
}