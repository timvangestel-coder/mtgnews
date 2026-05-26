import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Helper: create an in-memory DB and apply schema initialization
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// Import the schema initialization function once it exists
// For now, this test will fail because init-db.ts doesn't exist yet
async function initSchema(db: Database.Database): Promise<void> {
  const { initDb } = await import('./init-db');
  initDb(db);
}

describe('Schema initialization', () => {
  it('creates all five tables with correct schema', async () => {
    const db = createTestDb();

    // Apply schema
    await initSchema(db);

    // Verify tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('channels');
    expect(tableNames).toContain('signals');
    expect(tableNames).toContain('entity_mentions');
    expect(tableNames).toContain('poll_runs');
    expect(tableNames).toContain('poll_run_progress');
  });

  it('channels table has correct columns', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(channels)")
      .all() as { name: string; type: string; notnull: number }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull }])
    );

    expect(columnMap.has('channel_id')).toBe(true);
    expect(columnMap.get('channel_id')?.type).toBe('TEXT');
    expect(columnMap.has('display_name')).toBe(true);
    expect(columnMap.get('display_name')?.type).toBe('TEXT');
    expect(columnMap.has('avatar_url')).toBe(true);
    expect(columnMap.get('avatar_url')?.type).toBe('TEXT');
    expect(columnMap.has('added_at')).toBe(true);
    expect(columnMap.get('added_at')?.type).toBe('INTEGER');
    expect(columnMap.get('added_at')?.notnull).toBe(1);
  });

  it('channels table has topic_id column referencing topics (issue #52)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(channels)")
      .all() as { name: string; type: string }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type }])
    );

    expect(columnMap.has('topic_id')).toBe(true);
    expect(columnMap.get('topic_id')?.type).toBe('INTEGER');

    // filter_criteria should NOT exist (removed in issue #52)
    expect(columnMap.has('filter_criteria')).toBe(false);

    // Verify topic_id can be set via direct insert
    db.prepare(
      `INSERT INTO topics (key, short_name, filter_text) VALUES ('mtg', 'MTG', 'MTG filter')`
    ).run();
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES ('UC1', 'Test', 1700000000, 1)`
    ).run();

    const row = db
      .prepare('SELECT topic_id FROM channels WHERE channel_id = ?')
      .get('UC1') as { topic_id: number | null };

    expect(row?.topic_id).toBe(1);
  });

  it('channels table allows NULL topic_id', async () => {
    const db = createTestDb();
    await initSchema(db);

    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC2', 'No Topic', 1700000000)`
    ).run();

    const row = db
      .prepare('SELECT topic_id FROM channels WHERE channel_id = ?')
      .get('UC2') as { topic_id: number | null };

    expect(row?.topic_id).toBeNull();
  });

  it('signals table has relevance_status column (issue #44)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signals)")
      .all() as { name: string; type: string }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type }])
    );

    expect(columnMap.has('relevance_status')).toBe(true);
    expect(columnMap.get('relevance_status')?.type).toBe('TEXT');

    // Verify nullable - insert without relevance_status
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    const row = db
      .prepare('SELECT relevance_status FROM signals WHERE video_id = ?')
      .get('v1') as { relevance_status: string | null };

    // Column exists, value is null (not set)
    expect(row?.relevance_status).toBeNull();

    // Verify can update to 'relevant' and 'irrelevant'
    db.prepare('UPDATE signals SET relevance_status = ? WHERE video_id = ?').run('relevant', 'v1');
    const relevantRow = db
      .prepare('SELECT relevance_status FROM signals WHERE video_id = ?')
      .get('v1') as { relevance_status: string | null };
    expect(relevantRow?.relevance_status).toBe('relevant');

    db.prepare('UPDATE signals SET relevance_status = ? WHERE video_id = ?').run('irrelevant', 'v1');
    const irrelevantRow = db
      .prepare('SELECT relevance_status FROM signals WHERE video_id = ?')
      .get('v1') as { relevance_status: string | null };
    expect(irrelevantRow?.relevance_status).toBe('irrelevant');
  });

  it('signals table has correct columns including created_at and processed_at', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signals)")
      .all() as { name: string; type: string; notnull: number }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull }])
    );

    expect(columnMap.has('video_id')).toBe(true);
    expect(columnMap.get('video_id')?.type).toBe('TEXT');
    expect(columnMap.has('channel_id')).toBe(true);
    expect(columnMap.get('channel_id')?.type).toBe('TEXT');
    expect(columnMap.has('title')).toBe(true);
    expect(columnMap.get('title')?.type).toBe('TEXT');
    expect(columnMap.has('published_at')).toBe(true);
    expect(columnMap.get('published_at')?.type).toBe('TEXT');
    expect(columnMap.has('transcription')).toBe(true);
    expect(columnMap.get('transcription')?.type).toBe('TEXT');
    expect(columnMap.get('transcription')?.notnull).toBe(1);
    expect(columnMap.has('summary')).toBe(true);
    expect(columnMap.get('summary')?.type).toBe('TEXT');
    expect(columnMap.has('overall_sentiment')).toBe(true);
    expect(columnMap.get('overall_sentiment')?.type).toBe('INTEGER');
    expect(columnMap.has('sentiment_label')).toBe(true);
    expect(columnMap.get('sentiment_label')?.type).toBe('TEXT');
    expect(columnMap.has('created_at')).toBe(true);
    expect(columnMap.get('created_at')?.type).toBe('INTEGER');
    expect(columnMap.get('created_at')?.notnull).toBe(1);
    expect(columnMap.has('processed_at')).toBe(true);
    expect(columnMap.get('processed_at')?.type).toBe('INTEGER');
  });

  it('entity_mentions table has correct columns', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(entity_mentions)")
      .all() as { name: string; type: string; notnull: number }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull }])
    );

    expect(columnMap.has('id')).toBe(true);
    expect(columnMap.get('id')?.type).toBe('INTEGER');
    expect(columnMap.has('signal_video_id')).toBe(true);
    expect(columnMap.get('signal_video_id')?.type).toBe('TEXT');
    expect(columnMap.has('entity_name')).toBe(true);
    expect(columnMap.get('entity_name')?.type).toBe('TEXT');
    expect(columnMap.has('entity_type')).toBe(true);
    expect(columnMap.get('entity_type')?.type).toBe('TEXT');
    expect(columnMap.has('sentiment')).toBe(true);
    expect(columnMap.get('sentiment')?.type).toBe('TEXT');
  });

  it('poll_runs table has correct columns', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(poll_runs)")
      .all() as { name: string; type: string; notnull: number }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull }])
    );

    expect(columnMap.has('id')).toBe(true);
    expect(columnMap.get('id')?.type).toBe('INTEGER');
    expect(columnMap.has('triggered_at')).toBe(true);
    expect(columnMap.get('triggered_at')?.type).toBe('INTEGER');
    expect(columnMap.get('triggered_at')?.notnull).toBe(1);
    expect(columnMap.has('status')).toBe(true);
    expect(columnMap.get('status')?.type).toBe('TEXT');
    expect(columnMap.get('status')?.notnull).toBe(1);
    expect(columnMap.has('new_signal_count')).toBe(true);
    expect(columnMap.get('new_signal_count')?.type).toBe('INTEGER');
    expect(columnMap.has('completed_at')).toBe(true);
    expect(columnMap.get('completed_at')?.type).toBe('INTEGER');
  });

  it('poll_run_progress table has correct columns', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(poll_run_progress)")
      .all() as { name: string; type: string; notnull: number }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull }])
    );

    expect(columnMap.has('id')).toBe(true);
    expect(columnMap.get('id')?.type).toBe('INTEGER');
    expect(columnMap.has('poll_run_id')).toBe(true);
    expect(columnMap.get('poll_run_id')?.type).toBe('INTEGER');
    expect(columnMap.has('channel_id')).toBe(true);
    expect(columnMap.get('channel_id')?.type).toBe('TEXT');
    expect(columnMap.has('status')).toBe(true);
    expect(columnMap.get('status')?.type).toBe('TEXT');
    expect(columnMap.get('status')?.notnull).toBe(1);
    expect(columnMap.has('signals_found')).toBe(true);
    expect(columnMap.get('signals_found')?.type).toBe('INTEGER');
    expect(columnMap.has('updated_at')).toBe(true);
    expect(columnMap.get('updated_at')?.type).toBe('INTEGER');
    expect(columnMap.get('updated_at')?.notnull).toBe(1);
  });

  it('is idempotent — running twice does not error or create duplicates', async () => {
    const db = createTestDb();

    await initSchema(db);
    await initSchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    // Each table should appear exactly once
    expect(tableNames.filter((n) => n === 'channels').length).toBe(1);
    expect(tableNames.filter((n) => n === 'signals').length).toBe(1);
    expect(tableNames.filter((n) => n === 'entity_mentions').length).toBe(1);
    expect(tableNames.filter((n) => n === 'poll_runs').length).toBe(1);
    expect(tableNames.filter((n) => n === 'poll_run_progress').length).toBe(1);
  });

  it('enforces foreign key constraints', async () => {
    const db = createTestDb();
    await initSchema(db);

    // signals.channel_id must reference channels.channel_id
    expect(() => {
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, transcription, created_at)
         VALUES ('v1', 'nonexistent_channel', 'Test', '[]', 1700000000)`
      ).run();
    }).toThrow();
  });

  it('allows valid inserts into all tables', async () => {
    const db = createTestDb();
    await initSchema(db);

    // Insert channel
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, avatar_url, added_at)
       VALUES ('UC123', 'Test Channel', 'https://example.com/avatar.png', 1700000000)`
    ).run();

    // Insert signal
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at)
       VALUES ('v1', 'UC123', 'Test Video', '[]', 1700000000)`
    ).run();

    // Insert entity mention
    db.prepare(
      `INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment)
       VALUES ('v1', 'Karn Liberated', 'card', 'positive')`
    ).run();

    // Insert poll run
    db.prepare(
      `INSERT INTO poll_runs (triggered_at, status, new_signal_count)
       VALUES (1700000000, 'done', 1)`
    ).run();

    // Insert poll run progress
    const runId = db
      .prepare('SELECT id FROM poll_runs ORDER BY id DESC LIMIT 1')
      .get() as { id: number };

    db.prepare(
      `INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at)
       VALUES (?, 'UC123', 'done', 1, 1700000000)`
    ).run(runId.id);

    // Verify counts
    expect(
      db.prepare('SELECT COUNT(*) as cnt FROM channels').get()
    ).toEqual({ cnt: 1 });
    expect(
      db.prepare('SELECT COUNT(*) as cnt FROM signals').get()
    ).toEqual({ cnt: 1 });
    expect(
      db.prepare('SELECT COUNT(*) as cnt FROM entity_mentions').get()
    ).toEqual({ cnt: 1 });
    expect(
      db.prepare('SELECT COUNT(*) as cnt FROM poll_runs').get()
    ).toEqual({ cnt: 1 });
    expect(
      db.prepare('SELECT COUNT(*) as cnt FROM poll_run_progress').get()
    ).toEqual({ cnt: 1 });
  });
});