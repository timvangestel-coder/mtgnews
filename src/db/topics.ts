import Database from 'better-sqlite3';

export interface TopicRow {
  id: number;
  key: string;
  short_name: string;
  filter_text: string;
}

export interface UpdateTopicOptions {
  key?: string;
  short_name?: string;
  filter_text?: string;
}

export function createTopic(db: Database.Database, key: string, shortName: string, filterText: string): void {
  db.prepare(
    `INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)`
  ).run(key, shortName, filterText);
}

export function listTopics(db: Database.Database): TopicRow[] {
  return db.prepare(
    `SELECT t.id, t.key, t.short_name, t.filter_text FROM topics t ORDER BY t.id ASC`
  ).all();
}

export function getTopicById(db: Database.Database, id: number): TopicRow | undefined {
  const row = db.prepare('SELECT id, key, short_name, filter_text FROM topics WHERE id = ?').get(id);
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

  if (parts.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE topics SET ${parts.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTopic(db: Database.Database, id: number): void {
  // Force-delete: nullify channel references, then delete topic
  db.prepare('UPDATE channels SET topic_id = NULL WHERE topic_id = ?').run(id);
  db.prepare('DELETE FROM topics WHERE id = ?').run(id);
}