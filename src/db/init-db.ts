import Database from 'better-sqlite3';

export function initDb(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id    TEXT PRIMARY KEY,
        display_name  TEXT,
        avatar_url    TEXT,
        active        INTEGER DEFAULT 1,
        added_at      INTEGER NOT NULL,
        topic_id      INTEGER REFERENCES topics(id)
      );

    CREATE TABLE IF NOT EXISTS signals (
      video_id          TEXT PRIMARY KEY,
      channel_id        TEXT REFERENCES channels(channel_id),
      title             TEXT,
      published_at      TEXT,
      transcription     TEXT NOT NULL,
      summary           TEXT,
      overall_sentiment  INTEGER,
      sentiment_label   TEXT,
      created_at        INTEGER NOT NULL,
      processing_state  TEXT DEFAULT 'pending',
      poll_run_id       INTEGER REFERENCES poll_runs(id)
     );

    CREATE TABLE IF NOT EXISTS entity_mentions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_video_id TEXT REFERENCES signals(video_id),
      entity_name     TEXT,
      entity_type     TEXT,
      sentiment       TEXT
    );

    CREATE TABLE IF NOT EXISTS poll_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_at     INTEGER NOT NULL,
      status           TEXT NOT NULL,
      new_signal_count INTEGER DEFAULT 0,
      completed_at     INTEGER,
      lookback_days    INTEGER DEFAULT 2,
      abort_time       INTEGER,
      phase            TEXT DEFAULT 'channel_polling',
      signals_analyzed INTEGER DEFAULT 0
    );

     CREATE TABLE IF NOT EXISTS poll_run_progress (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       poll_run_id   INTEGER REFERENCES poll_runs(id),
       channel_id    TEXT,
       status        TEXT NOT NULL,
       signals_found INTEGER DEFAULT 0,
       updated_at    INTEGER NOT NULL
     );

      CREATE TABLE IF NOT EXISTS topics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT UNIQUE NOT NULL,
        short_name    TEXT NOT NULL,
        filter_text   TEXT NOT NULL,
        summary_prompt TEXT
      );
   `);

  // Migration: add missing columns for existing databases
  const channelRows = db.pragma('table_info(channels)') as Array<{ name: string }>;
  const channelCols = channelRows.map((r) => r.name);
  if (!channelCols.includes('active')) {
    db.exec('ALTER TABLE channels ADD COLUMN active INTEGER DEFAULT 1');
  }

  // Migration: add lookback_days to poll_runs
  const pollRunRows = db.pragma('table_info(poll_runs)') as Array<{ name: string }>;
  const pollRunCols = pollRunRows.map((r) => r.name);
  if (!pollRunCols.includes('lookback_days')) {
    db.exec('ALTER TABLE poll_runs ADD COLUMN lookback_days INTEGER DEFAULT 2');
  }

  // Migration: add abort_time to poll_runs (issue #40)
  if (!pollRunCols.includes('abort_time')) {
    db.exec('ALTER TABLE poll_runs ADD COLUMN abort_time INTEGER');
  }

  // Migration: add poll_run_id to signals (issue #43)
  const signalRows = db.pragma('table_info(signals)') as Array<{ name: string }>;
  const signalCols = signalRows.map((r) => r.name);
  if (!signalCols.includes('poll_run_id')) {
    db.exec('ALTER TABLE signals ADD COLUMN poll_run_id INTEGER REFERENCES poll_runs(id)');
  }

  // Issue #85/#88: Migration: add processing_state, backfill from old columns, drop old columns
  if (!signalCols.includes('processing_state')) {
    // Add new column
    db.exec("ALTER TABLE signals ADD COLUMN processing_state TEXT DEFAULT 'pending'");

    // Backfill: processed_at IS NOT NULL -> summarized
    db.exec("UPDATE signals SET processing_state = 'summarized' WHERE processed_at IS NOT NULL");

    // Backfill: relevance_status = 'irrelevant' -> irrelevant (overrides summarized if both set)
    db.exec("UPDATE signals SET processing_state = 'irrelevant' WHERE relevance_status = 'irrelevant'");
  }

  // Drop old columns after migration
  if (signalCols.includes('processed_at')) {
    db.exec('ALTER TABLE signals DROP COLUMN processed_at');
  }
  if (signalCols.includes('relevance_status')) {
    db.exec('ALTER TABLE signals DROP COLUMN relevance_status');
  }

  // Migration: add topic_id to channels (issue #52)
  if (!channelCols.includes('topic_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN topic_id INTEGER REFERENCES topics(id)');
  }

  // Migration: drop filter_criteria from channels (issue #52)
  if (channelCols.includes('filter_criteria')) {
    db.exec('ALTER TABLE channels DROP COLUMN filter_criteria');
  }

  // Issue #77: Migration: add phase to poll_runs
  if (!pollRunCols.includes('phase')) {
    db.exec("ALTER TABLE poll_runs ADD COLUMN phase TEXT DEFAULT 'channel_polling'");
  }

  // Issue #77: Migration: add signals_analyzed to poll_runs
  if (!pollRunCols.includes('signals_analyzed')) {
    db.exec('ALTER TABLE poll_runs ADD COLUMN signals_analyzed INTEGER DEFAULT 0');
  }

   // Issue #75/#77: Migration: add signals_to_analyze to poll_runs (total signals needing analysis)
   if (!pollRunCols.includes('signals_to_analyze')) {
     db.exec('ALTER TABLE poll_runs ADD COLUMN signals_to_analyze INTEGER DEFAULT 0');
   }

    // Migration: add signals_done to poll_run_progress (tracks how many signals per channel have been summarized)
    const progressRows = db.pragma('table_info(poll_run_progress)') as Array<{ name: string }>;
    const progressCols = progressRows.map((r) => r.name);
    if (!progressCols.includes('signals_done')) {
      db.exec('ALTER TABLE poll_run_progress ADD COLUMN signals_done INTEGER DEFAULT 0');
    }

    // Issue #98: Migration: add summary_prompt to topics (nullable TEXT for per-topic prompt templates)
    const topicRows = db.pragma('table_info(topics)') as Array<{ name: string }>;
    const topicCols = topicRows.map((r) => r.name);
    if (!topicCols.includes('summary_prompt')) {
      db.exec('ALTER TABLE topics ADD COLUMN summary_prompt TEXT');
    }

     // Issue #102: app_settings key/value table for runtime-configurable global defaults
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Issue #114: Migration: add generated_title to signals (TEXT, nullable)
    if (!signalCols.includes('generated_title')) {
      db.exec('ALTER TABLE signals ADD COLUMN generated_title TEXT');
    }

    // Issue #106: signal_chat table for threaded Q&A per Signal
   db.exec(`
     CREATE TABLE IF NOT EXISTS signal_chat (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       signal_video_id TEXT NOT NULL REFERENCES signals(video_id),
       question        TEXT NOT NULL,
       answer          TEXT,
       created_at      TEXT DEFAULT (datetime('now'))
     )
   `);

   // Issue #120: Migration — fix answer column to be nullable for async processing
   // The original table may have been created with answer TEXT NOT NULL.
   // SQLite cannot ALTER COLUMN, so we recreate the table if needed.
   const chatRows = db.pragma('table_info(signal_chat)') as Array<{ name: string; notnull: number }>;
   const answerCol = chatRows.find((r) => r.name === 'answer');
   if (answerCol && answerCol.notnull === 1) {
     // Recreate table with nullable answer column
     db.exec('ALTER TABLE signal_chat RENAME TO signal_chat_old');
     db.exec(`
       CREATE TABLE signal_chat (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         signal_video_id TEXT NOT NULL REFERENCES signals(video_id),
         question        TEXT NOT NULL,
         answer          TEXT,
         created_at      TEXT DEFAULT (datetime('now'))
       )
     `);
     db.exec(`
       INSERT INTO signal_chat (id, signal_video_id, question, answer, created_at)
       SELECT id, signal_video_id, question, answer, created_at FROM signal_chat_old
     `);
     db.exec('DROP TABLE signal_chat_old');
   }
}
