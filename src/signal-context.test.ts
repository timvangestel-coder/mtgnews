import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './db/init-db';
import { resolveSignalContext } from './signal-context';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('topics table has summary_prompt column (issue #98)', () => {
  it('summary_prompt column exists and is nullable TEXT', () => {
    const db = createTestDb();

    const columns = db
      .prepare("PRAGMA table_info(topics)")
      .all() as Array<{ name: string; type: string }>;

    const columnMap = new Map(columns.map((c) => [c.name, c.type]));

    expect(columnMap.has('summary_prompt')).toBe(true);
    expect(columnMap.get('summary_prompt')).toBe('TEXT');
  });

  it('summary_prompt defaults to NULL when not provided', () => {
    const db = createTestDb();

    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text) VALUES ('mtg', 'MTG', 'MTG content')`
    ).run();

    const row = db
      .prepare('SELECT summary_prompt FROM topics WHERE id = ?')
      .get(1) as { summary_prompt: string | null } | undefined;

    expect(row?.summary_prompt).toBeNull();
  });

  it('summary_prompt accepts a custom template', () => {
    const db = createTestDb();

    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text, summary_prompt) VALUES ('ai', 'AI', 'AI content', 'Custom prompt template')`
    ).run();

    const row = db
      .prepare('SELECT summary_prompt FROM topics WHERE id = ?')
      .get(1) as { summary_prompt: string | null } | undefined;

    expect(row?.summary_prompt).toBe('Custom prompt template');
  });
});

describe('resolveSignalContext (issue #98)', () => {
  function seedDb(db: Database.Database): void {
    // Insert topic with custom prompt
    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text, summary_prompt) VALUES ('mtg', 'MTG', 'Magic cards and sets', 'Analyze MTG content')`
    ).run();

    // Insert channel linked to topic
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES ('UC_mtg', 'MTG Channel', 1700000000, 1)`
    ).run();

    // Insert signal linked to channel
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v_mtg_1', 'UC_mtg', 'MTG Video', '{"segments":[]}', 1700000000)`
    ).run();

    // Insert topic without custom prompt
    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text) VALUES ('ai', 'AI', 'AI content')`
    ).run();

    // Insert channel linked to topic without prompt
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES ('UC_ai', 'AI Channel', 1700000000, 2)`
    ).run();

    // Insert signal for ai channel
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v_ai_1', 'UC_ai', 'AI Video', '{"raw":true}', 1700000000)`
    ).run();
  }

  it('returns SignalContext with all four fields from single joined query', () => {
    const db = createTestDb();
    seedDb(db);

    const context = resolveSignalContext('v_mtg_1', db);

    expect(context.transcriptionJson).toBe('{"segments":[]}');
    expect(context.topicId).toBe(1);
    expect(context.filterText).toBe('Magic cards and sets');
    expect(context.summaryPrompt).toBe('Analyze MTG content');
  });

  it('throws for missing video ID', () => {
    const db = createTestDb();
    seedDb(db);

    expect(() => resolveSignalContext('nonexistent', db)).toThrow();
  });

  it('returns null summaryPrompt when topic has no custom prompt', () => {
    const db = createTestDb();
    seedDb(db);

    const context = resolveSignalContext('v_ai_1', db);

    expect(context.transcriptionJson).toBe('{"raw":true}');
    expect(context.topicId).toBe(2);
    expect(context.filterText).toBe('AI content');
    expect(context.summaryPrompt).toBeNull();
  });
});