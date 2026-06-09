import Database from 'better-sqlite3';
import { createTopic as dbCreateTopic, updateTopic as dbUpdateTopic, deleteTopic as dbDeleteTopic, getTopicById, getTopicByKey, TopicRow, TopicWithCount, UpdateTopicOptions } from '../db/watchlist';

export interface TopicWithChannelCount extends TopicWithCount {}

export class TopicManager {
  constructor(private db: Database.Database) {}

  getTopicWithCount(id: number): TopicWithCount | undefined {
    const topic = getTopicById(this.db, id);
    if (!topic) return undefined;
    const row = this.db.prepare('SELECT COUNT(*) as c FROM channels WHERE topic_id = ?').get(id) as { c: number };
    return { ...topic, channel_count: row.c };
  }

  getByKey(key: string): TopicRow | undefined {
    return getTopicByKey(this.db, key);
  }

  create(key: string, shortName: string, filterText: string, summaryPrompt?: string | null): void {
    dbCreateTopic(this.db, key, shortName, filterText, summaryPrompt);
  }

  update(id: number, opts: UpdateTopicOptions): void {
    dbUpdateTopic(this.db, id, opts);
  }

  delete(id: number): void {
    dbDeleteTopic(this.db, id);
  }

  listWithCounts(): TopicWithCount[] {
    return this.db.prepare(`
      SELECT t.id, t.key, t.short_name, t.filter_text, t.summary_prompt, t.multi_signal_summary_prompt,
             COUNT(c.channel_id) AS channel_count
      FROM topics t
      LEFT JOIN channels c ON c.topic_id = t.id
      GROUP BY t.id
      ORDER BY t.id ASC
    `).all() as TopicWithCount[];
  }
}
