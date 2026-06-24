import Database from 'better-sqlite3';

/* ── Types ── */

export interface ChannelRow {
  channel_id: string;
  display_name: string | null;
  avatar_url: string | null;
  active: number;
  added_at: number;
  topic_id: number | null;
}

export interface ChannelWithTopic extends ChannelRow {
  topic_key: string | null;
}

export interface TopicRow {
  id: number;
  key: string;
  short_name: string;
  filter_text: string;
  summary_prompt: string | null;
  multi_signal_summary_prompt: string | null;
}

export interface UpdateTopicOptions {
  key?: string;
  short_name?: string;
  filter_text?: string;
  summary_prompt?: string | null;
  multi_signal_summary_prompt?: string | null;
}

export interface TopicWithCount extends TopicRow {
  channel_count: number;
}

export interface AdminChannel extends ChannelWithTopic {
  last_poll_date: number | null;
}

export interface AdminData {
  channels: AdminChannel[];
  topics: TopicWithCount[];
}

/* ── Deep queries (composed, no N+1) ── */

const CHANNELS_WITH_TOPICS_SQL = `
  SELECT c.channel_id, c.display_name, c.avatar_url, c.active, c.added_at,
         c.topic_id, t.key AS topic_key
  FROM channels c
  LEFT JOIN topics t ON c.topic_id = t.id
`;

export function getChannelsWithTopics(db: Database.Database): ChannelWithTopic[] {
  return db.prepare(CHANNELS_WITH_TOPICS_SQL + ' ORDER BY c.added_at DESC').all() as ChannelWithTopic[];
}

export function listActiveChannels(db: Database.Database): ChannelWithTopic[] {
  return db.prepare(
    CHANNELS_WITH_TOPICS_SQL + ' WHERE c.active = 1 AND c.topic_id IS NOT NULL ORDER BY c.added_at DESC'
  ).all() as ChannelWithTopic[];
}

export function getAdminData(db: Database.Database): AdminData {
  const channels: AdminChannel[] = db.prepare(`
    SELECT c.channel_id, c.display_name, c.avatar_url, c.active, c.added_at,
           c.topic_id, t.key AS topic_key,
           MAX(p.updated_at) AS last_poll_date
    FROM channels c
    LEFT JOIN topics t ON c.topic_id = t.id
    LEFT JOIN poll_run_progress p ON p.channel_id = c.channel_id
    GROUP BY c.channel_id
    ORDER BY c.added_at DESC
  `).all() as AdminChannel[];

  const topics: TopicWithCount[] = db.prepare(`
    SELECT t.id, t.key, t.short_name, t.filter_text, t.summary_prompt, t.multi_signal_summary_prompt,
           COUNT(c.channel_id) AS channel_count
    FROM topics t
    LEFT JOIN channels c ON c.topic_id = t.id
    GROUP BY t.id
    ORDER BY t.id ASC
  `).all() as TopicWithCount[];

  return { channels, topics };
}

/* ── Channel CRUD ── */

export function addChannel(
  db: Database.Database,
  channelId: string,
  displayName?: string,
  avatarUrl?: string,
  topicId?: number | null
): void {
  db.prepare(
    `INSERT OR IGNORE INTO channels (channel_id, display_name, avatar_url, active, added_at, topic_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(channelId, displayName ?? null, avatarUrl ?? null, 1, Date.now(), topicId ?? null);
}

export function updateChannelTopic(db: Database.Database, channelId: string, topicId: number | null): void {
  db.prepare('UPDATE channels SET topic_id = ? WHERE channel_id = ?').run(topicId, channelId);
}

export function removeChannel(db: Database.Database, channelId: string): void {
  const txn = db.transaction((channelId: string) => {
    // Delete in FK order: entity_mentions → signals → channels
    const signals = db.prepare(
      'SELECT video_id FROM signals WHERE channel_id = ?'
    ).all(channelId);
    for (const { video_id } of signals as Array<{ video_id: string }>) {
      db.prepare('DELETE FROM entity_mentions WHERE signal_video_id = ?').run(video_id);
      db.prepare('DELETE FROM signals WHERE video_id = ?').run(video_id);
    }
    db.prepare('DELETE FROM channels WHERE channel_id = ?').run(channelId);
  });
  txn(channelId);
}

export function toggleChannelActive(db: Database.Database, channelId: string, active: boolean): void {
  db.prepare('UPDATE channels SET active = ? WHERE channel_id = ?').run(active ? 1 : 0, channelId);
}

export function updateChannelInfo(db: Database.Database, channelId: string, displayName: string, avatarUrl: string): void {
  db.prepare('UPDATE channels SET display_name = ?, avatar_url = ? WHERE channel_id = ?').run(displayName, avatarUrl, channelId);
}

export function listChannels(db: Database.Database): ChannelRow[] {
  return db.prepare(
    'SELECT channel_id, display_name, avatar_url, active, added_at, topic_id FROM channels ORDER BY added_at DESC'
  ).all() as ChannelRow[];
}

export function getChannelLastPollDate(db: Database.Database, channelId: string): number | null {
  const row = db.prepare(
    'SELECT MAX(updated_at) as last_poll FROM poll_run_progress WHERE channel_id = ?'
  ).get(channelId) as { last_poll: number | null } | undefined;
  return row?.last_poll ?? null;
}

/* ── Topic CRUD ── */

export function createTopic(db: Database.Database, key: string, shortName: string, filterText: string, summaryPrompt?: string | null, multiSignalSummaryPrompt?: string | null): void {
  db.prepare(
    `INSERT INTO topics (key, short_name, filter_text, summary_prompt, multi_signal_summary_prompt) VALUES (?, ?, ?, ?, ?)`
  ).run(key, shortName, filterText, summaryPrompt ?? null, multiSignalSummaryPrompt ?? null);
}

export function listTopics(db: Database.Database): TopicRow[] {
  return db.prepare(
    `SELECT t.id, t.key, t.short_name, t.filter_text, t.summary_prompt, t.multi_signal_summary_prompt FROM topics t ORDER BY t.id ASC`
  ).all() as TopicRow[];
}

export function getTopicById(db: Database.Database, id: number): TopicRow | undefined {
  const row = db.prepare('SELECT id, key, short_name, filter_text, summary_prompt, multi_signal_summary_prompt FROM topics WHERE id = ?').get(id);
  return (row as TopicRow) ?? undefined;
}

export function getTopicByKey(db: Database.Database, key: string): TopicRow | undefined {
  const row = db.prepare('SELECT id, key, short_name, filter_text, summary_prompt, multi_signal_summary_prompt FROM topics WHERE key = ?').get(key);
  return (row as TopicRow) ?? undefined;
}

export function updateTopic(db: Database.Database, id: number, opts: UpdateTopicOptions): void {
  const parts: string[] = [];
  const values: unknown[] = [];

  if (opts.key !== undefined) {
    parts.push('key = ?');
    values.push(opts.key);
  }
  if (opts.short_name !== undefined) {
    parts.push('short_name = ?');
    values.push(opts.short_name);
  }
  if (opts.filter_text !== undefined) {
    parts.push('filter_text = ?');
    values.push(opts.filter_text);
  }
  if (opts.summary_prompt !== undefined) {
    parts.push('summary_prompt = ?');
    values.push(opts.summary_prompt ?? null);
  }
  if (opts.multi_signal_summary_prompt !== undefined) {
    parts.push('multi_signal_summary_prompt = ?');
    values.push(opts.multi_signal_summary_prompt ?? null);
  }

  if (parts.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE topics SET ${parts.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTopic(db: Database.Database, id: number): void {
  // Force-delete: nullify channel references, then delete topic
  db.prepare('UPDATE channels SET topic_id = NULL WHERE topic_id = ?').run(id);
  db.prepare('DELETE FROM topics WHERE id = ?').run(id);
}