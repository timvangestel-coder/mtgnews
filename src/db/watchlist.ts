import Database from 'better-sqlite3';

export interface ChannelRow {
  channel_id: string;
  display_name: string | null;
  avatar_url: string | null;
  active: number;
  added_at: number;
  topic_id: number | null;
}

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
  const fk = db.pragma('foreign_keys', { read: true });
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM channels WHERE channel_id = ?').run(channelId);
  db.pragma('foreign_keys', fk);
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
  ).all();
}

export function getChannelLastPollDate(db: Database.Database, channelId: string): number | null {
  const row = db.prepare(
    'SELECT MAX(updated_at) as last_poll FROM poll_run_progress WHERE channel_id = ?'
  ).get(channelId) as { last_poll: number | null } | undefined;
  return row?.last_poll ?? null;
}

export function listActiveChannels(db: Database.Database): ChannelRow[] {
  return db.prepare(
    'SELECT channel_id, display_name, avatar_url, active, added_at, topic_id FROM channels WHERE active = 1 AND topic_id IS NOT NULL ORDER BY added_at DESC'
  ).all();
}