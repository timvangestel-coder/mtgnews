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

  it('signals table has processing_state column (issue #85/#88)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signals)")
      .all() as { name: string; type: string }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    // processing_state must exist with DEFAULT 'pending'
    expect(columnMap.has('processing_state')).toBe(true);
    expect(columnMap.get('processing_state')?.type).toBe('TEXT');
    expect(columnMap.get('processing_state')?.dflt_value).toBe("'pending'");

    // Old columns must NOT exist (dropped in issue #85)
    expect(columnMap.has('processed_at')).toBe(false);
    expect(columnMap.has('relevance_status')).toBe(false);

    // Verify default value is 'pending' on insert
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    const row = db
      .prepare('SELECT processing_state FROM signals WHERE video_id = ?')
      .get('v1') as { processing_state: string | null };

    expect(row?.processing_state).toBe('pending');

    // Verify can set to 'summarized' and 'irrelevant'
    db.prepare('UPDATE signals SET processing_state = ? WHERE video_id = ?').run('summarized', 'v1');
    const summarizedRow = db
      .prepare('SELECT processing_state FROM signals WHERE video_id = ?')
      .get('v1') as { processing_state: string | null };
    expect(summarizedRow?.processing_state).toBe('summarized');

    db.prepare('UPDATE signals SET processing_state = ? WHERE video_id = ?').run('irrelevant', 'v1');
    const irrelevantRow = db
      .prepare('SELECT processing_state FROM signals WHERE video_id = ?')
      .get('v1') as { processing_state: string | null };
    expect(irrelevantRow?.processing_state).toBe('irrelevant');
  });

  it('migration backfills processing_state from old processed_at and relevance_status (issue #85)', async () => {
    // Simulate an existing DB that has old columns but no processing_state
    const db = createTestDb();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create old-style schema (without processing_state)
    db.exec(`
      CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        display_name TEXT,
        avatar_url TEXT,
        active INTEGER DEFAULT 1,
        added_at INTEGER NOT NULL,
        topic_id INTEGER REFERENCES topics(id)
      );
      CREATE TABLE signals (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT REFERENCES channels(channel_id),
        title TEXT,
        published_at TEXT,
        transcription TEXT NOT NULL,
        summary TEXT,
        overall_sentiment INTEGER,
        sentiment_label TEXT,
        created_at INTEGER NOT NULL,
        processed_at INTEGER,
        poll_run_id INTEGER REFERENCES poll_runs(id),
        relevance_status TEXT
      );
      CREATE TABLE entity_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_video_id TEXT REFERENCES signals(video_id),
        entity_name TEXT,
        entity_type TEXT,
        sentiment TEXT
      );
      CREATE TABLE poll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        triggered_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        new_signal_count INTEGER DEFAULT 0,
        completed_at INTEGER,
        lookback_days INTEGER DEFAULT 2,
        abort_time INTEGER,
        phase TEXT DEFAULT 'channel_polling',
        signals_analyzed INTEGER DEFAULT 0
      );
      CREATE TABLE poll_run_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_run_id INTEGER REFERENCES poll_runs(id),
        channel_id TEXT,
        status TEXT NOT NULL,
        signals_found INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        short_name TEXT NOT NULL,
        filter_text TEXT NOT NULL
      );
    `);

    // Insert test data with old columns
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    // Signal with processed_at set -> should become 'summarized'
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at, processed_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000, 1700000100)`
    ).run();
    // Signal with relevance_status='irrelevant' -> should become 'irrelevant'
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at, relevance_status) VALUES ('v2', 'UC1', 'Test', '[]', 1700000000, 'irrelevant')`
    ).run();
    // Signal with neither -> should become 'pending'
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v3', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    // Now run initDb (which applies migrations)
    await initSchema(db);

    // Verify backfill worked
    const v1 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v1') as { processing_state: string };
    expect(v1.processing_state).toBe('summarized');

    const v2 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v2') as { processing_state: string };
    expect(v2.processing_state).toBe('irrelevant');

    const v3 = db.prepare('SELECT processing_state FROM signals WHERE video_id = ?').get('v3') as { processing_state: string };
    expect(v3.processing_state).toBe('pending');

    // Old columns should be dropped
    const columns = db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).not.toContain('processed_at');
    expect(colNames).not.toContain('relevance_status');
  });

  it('signals table has correct columns including created_at and processing_state', async () => {
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
    // processed_at removed in issue #85, replaced by processing_state
    expect(columnMap.has('processing_state')).toBe(true);
    expect(columnMap.get('processing_state')?.type).toBe('TEXT');
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

  // Issue #77: phase tracking with analysis counter
  it('poll_runs table has phase column (issue #77)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(poll_runs)")
      .all() as { name: string; type: string }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type }])
    );

    expect(columnMap.has('phase')).toBe(true);
    expect(columnMap.get('phase')?.type).toBe('TEXT');

    // Verify default value is 'channel_polling'
    db.prepare(
      `INSERT INTO poll_runs (triggered_at, status) VALUES (1700000000, 'pending')`
    ).run();

    const row = db.prepare('SELECT phase FROM poll_runs').get() as { phase: string | null };
    expect(row?.phase).toBe('channel_polling');
  });

  it('poll_runs table has signals_analyzed column (issue #77)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(poll_runs)")
      .all() as { name: string; type: string }[];

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type }])
    );

    expect(columnMap.has('signals_analyzed')).toBe(true);
    expect(columnMap.get('signals_analyzed')?.type).toBe('INTEGER');

    // Verify default value is 0
    db.prepare(
      `INSERT INTO poll_runs (triggered_at, status) VALUES (1700000000, 'pending')`
    ).run();

    const row = db.prepare('SELECT signals_analyzed FROM poll_runs').get() as { signals_analyzed: number | null };
    expect(row?.signals_analyzed).toBe(0);
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

  // Issue #106: signal_chat table for threaded Q&A per Signal
  it('signal_chat table exists after init (issue #106)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('signal_chat');
  });

  it('signal_chat table has correct schema (issue #106)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signal_chat)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }])
    );

    // id INTEGER PRIMARY KEY AUTOINCREMENT
    expect(columnMap.has('id')).toBe(true);
    expect(columnMap.get('id')?.type).toBe('INTEGER');

    // signal_video_id TEXT (nullable for list-scoped chat — issue #130)
    expect(columnMap.has('signal_video_id')).toBe(true);
    expect(columnMap.get('signal_video_id')?.type).toBe('TEXT');
    expect(columnMap.get('signal_video_id')?.notnull).toBe(0);

    // question TEXT NOT NULL
    expect(columnMap.has('question')).toBe(true);
    expect(columnMap.get('question')?.type).toBe('TEXT');
    expect(columnMap.get('question')?.notnull).toBe(1);

    // answer TEXT (nullable - Issue #116: failed questions have NULL answer)
    expect(columnMap.has('answer')).toBe(true);
    expect(columnMap.get('answer')?.type).toBe('TEXT');
    expect(columnMap.get('answer')?.notnull).toBe(0);

    // created_at DEFAULT datetime('now')
    expect(columnMap.has('created_at')).toBe(true);
    expect(columnMap.get('created_at')?.dflt_value).toContain("datetime('now')");
  });

  it('signal_chat enforces foreign key to signals(video_id) (issue #106)', async () => {
    const db = createTestDb();
    await initSchema(db);

    // Insert a channel and signal first
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    // Insert with valid signal_video_id should succeed
    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES ('v1', 'What card?', 'Karn Liberated')`
    ).run();

    const row = db.prepare('SELECT * FROM signal_chat WHERE id = 1').get();
    expect(row).toBeDefined();
    expect((row as { signal_video_id: string }).signal_video_id).toBe('v1');
    expect((row as { question: string }).question).toBe('What card?');
    expect((row as { answer: string }).answer).toBe('Karn Liberated');

    // Insert with nonexistent video_id should throw (FK enforced)
    expect(() => {
      db.prepare(
        `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES ('nonexistent', 'Q', 'A')`
      ).run();
    }).toThrow();
  });

  it('signal_chat created_at defaults to current datetime (issue #106)', async () => {
    const db = createTestDb();
    await initSchema(db);

    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES ('v1', 'Q', 'A')`
    ).run();

    const row = db.prepare('SELECT created_at FROM signal_chat WHERE id = 1').get() as { created_at: string };
    expect(row?.created_at).toBeDefined();
    // Should be a valid ISO-ish datetime string (YYYY-MM-DD HH:MM:SS)
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('signal_chat allows multiple independent Q&A pairs per signal (issue #106)', async () => {
    const db = createTestDb();
    await initSchema(db);

    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();

    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES ('v1', 'Q1', 'A1')`
    ).run();
    db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES ('v1', 'Q2', 'A2')`
    ).run();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM signal_chat WHERE signal_video_id = ?').get('v1');
    expect((count as { cnt: number }).cnt).toBe(2);

    // Delete one row independently
    db.prepare('DELETE FROM signal_chat WHERE id = 1').run();
    const countAfter = db.prepare('SELECT COUNT(*) as cnt FROM signal_chat WHERE signal_video_id = ?').get('v1');
    expect((countAfter as { cnt: number }).cnt).toBe(1);
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

  // Issue #185: soft-delete migration — deleted_at columns on 5 tables
  it('channels table has deleted_at column defaulting NULL (issue #185)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(channels)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    expect(columnMap.has('deleted_at')).toBe(true);
    expect(columnMap.get('deleted_at')?.type).toBe('INTEGER');
    expect(columnMap.get('deleted_at')?.dflt_value).toBe('NULL');

    // Verify new rows have NULL (active)
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();

    const row = db
      .prepare('SELECT deleted_at FROM channels WHERE channel_id = ?')
      .get('UC1') as { deleted_at: number | null };

    expect(row?.deleted_at).toBeNull();
  });

  it('signals table has deleted_at column defaulting NULL (issue #185)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signals)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    expect(columnMap.has('deleted_at')).toBe(true);
    expect(columnMap.get('deleted_at')?.type).toBe('INTEGER');
    expect(columnMap.get('deleted_at')?.dflt_value).toBe('NULL');
  });

  it('entity_mentions table has deleted_at column defaulting NULL (issue #185)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(entity_mentions)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    expect(columnMap.has('deleted_at')).toBe(true);
    expect(columnMap.get('deleted_at')?.type).toBe('INTEGER');
    expect(columnMap.get('deleted_at')?.dflt_value).toBe('NULL');
  });

  it('signal_chat table has deleted_at column defaulting NULL (issue #185)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(signal_chat)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    expect(columnMap.has('deleted_at')).toBe(true);
    expect(columnMap.get('deleted_at')?.type).toBe('INTEGER');
    expect(columnMap.get('deleted_at')?.dflt_value).toBe('NULL');
  });

  it('poll_run_progress table has deleted_at column defaulting NULL (issue #185)', async () => {
    const db = createTestDb();
    await initSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(poll_run_progress)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null }>;

    const columnMap = new Map(
      columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }])
    );

    expect(columnMap.has('deleted_at')).toBe(true);
    expect(columnMap.get('deleted_at')?.type).toBe('INTEGER');
    expect(columnMap.get('deleted_at')?.dflt_value).toBe('NULL');
  });

  it('migration adds deleted_at to existing tables without dropping data (issue #185)', async () => {
    // Simulate an existing DB that has the schema but no deleted_at columns
    const db = createTestDb();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create minimal old-style tables (without deleted_at)
    db.exec(`
      CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        display_name TEXT,
        avatar_url TEXT,
        active INTEGER DEFAULT 1,
        added_at INTEGER NOT NULL,
        topic_id INTEGER REFERENCES topics(id)
      );
      CREATE TABLE signals (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT REFERENCES channels(channel_id),
        title TEXT,
        published_at TEXT,
        transcription TEXT NOT NULL,
        summary TEXT,
        overall_sentiment INTEGER,
        sentiment_label TEXT,
        created_at INTEGER NOT NULL,
        processing_state TEXT DEFAULT 'pending',
        poll_run_id INTEGER REFERENCES poll_runs(id)
      );
      CREATE TABLE entity_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_video_id TEXT REFERENCES signals(video_id),
        entity_name TEXT,
        entity_type TEXT,
        sentiment TEXT
      );
      CREATE TABLE poll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        triggered_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        new_signal_count INTEGER DEFAULT 0,
        completed_at INTEGER,
        lookback_days INTEGER DEFAULT 2,
        abort_time INTEGER,
        phase TEXT DEFAULT 'channel_polling',
        signals_analyzed INTEGER DEFAULT 0
      );
      CREATE TABLE poll_run_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_run_id INTEGER REFERENCES poll_runs(id),
        channel_id TEXT,
        status TEXT NOT NULL,
        signals_found INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        short_name TEXT NOT NULL,
        filter_text TEXT NOT NULL
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE signal_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_video_id TEXT REFERENCES signals(video_id),
        question TEXT NOT NULL,
        answer TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        topic_key TEXT,
        channel_id TEXT,
        include_irrelevant INTEGER DEFAULT 0,
        is_formatted INTEGER DEFAULT 0,
        date_filter TEXT DEFAULT 'all'
      );
    `);

    // Insert existing data
    db.prepare(
      `INSERT INTO channels (channel_id, display_name, added_at) VALUES ('UC1', 'Test', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES ('v1', 'UC1', 'Test', '[]', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type) VALUES ('v1', 'MTG', 'topic')`
    ).run();

    // Run initDb — should add deleted_at columns via migration
    await initSchema(db);

    // Verify all 5 tables now have deleted_at
    const checkTable = (name: string) => {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('deleted_at');
    };

    checkTable('channels');
    checkTable('signals');
    checkTable('entity_mentions');
    checkTable('signal_chat');
    checkTable('poll_run_progress');

    // Verify existing rows still exist and have NULL deleted_at (active)
    const channel = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC1') as { deleted_at: number | null };
    expect(channel?.deleted_at).toBeNull();

    const signal = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v1') as { deleted_at: number | null };
    expect(signal?.deleted_at).toBeNull();

    const mention = db.prepare('SELECT deleted_at FROM entity_mentions WHERE id = 1').get() as { deleted_at: number | null };
    expect(mention?.deleted_at).toBeNull();
  });
});
