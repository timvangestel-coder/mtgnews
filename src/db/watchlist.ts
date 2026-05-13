import Database from 'better-sqlite3';

export interface ChannelRow {
  channel_id: string;
  display_name: string | null;
  avatar_url: string | null;
  added_at: number;
}

export function addChannel(db: Database.Database, channelId: string, displayName?: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)`
  ).run(channelId, displayName ?? null, Date.now());
}

export function removeChannel(db: Database.Database, channelId: string): void {
  const fk = db.pragma('foreign_keys', { read: true });
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM channels WHERE channel_id = ?').run(channelId);
  db.pragma('foreign_keys', fk);
}

export function listChannels(db: Database.Database): ChannelRow[] {
  return db.prepare('SELECT channel_id, display_name, avatar_url, added_at FROM channels ORDER BY added_at DESC').all();
}