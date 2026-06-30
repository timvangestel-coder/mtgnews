import { Router } from 'express';
import Database from 'better-sqlite3';
import { ChannelManager } from '../services/channel-manager';
import { TopicManager } from '../services/topic-manager';
import { PollRunManager } from '../poll-run-manager';
import { getAppSetting } from '../db/app-settings';
import { getDbWideSoftDeleteCounts } from '../db/cascade-delete';

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
    dataFn: ({ topicManager, db }) => ({
      topics: topicManager.listWithCounts(),
      defaultPrompt: getAppSetting(db, 'default_summary_prompt'),
    }),
  },
  {
    key: 'polling',
    partial: 'admin/_pollingTab',
    dataFn: ({ pollRunManager }) => {
      const prog = pollRunManager.progress();
      return {
        state: prog?.state.status === 'running' ? prog.state : null,
      };
    },
  },
  {
    key: 'data',
    partial: 'admin/_dataTab',
    dataFn: ({ db }) => {
      const counts = getDbWideSoftDeleteCounts(db);
      const softDeleteTotal =
        counts.channels +
        counts.signals +
        counts.mentions +
        counts.chats +
        counts.progress;
      return { softDeleteCounts: counts, softDeleteTotal };
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