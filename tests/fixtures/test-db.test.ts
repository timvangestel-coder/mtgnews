import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedChannel, seedSignal } from './test-db';

describe('test-db fixtures', () => {
  describe('createTestDb', () => {
    it('returns a Database instance', () => {
      const db = createTestDb();
      expect(db).toBeDefined();
      // Verify it's a real better-sqlite3 database by checking prepare exists
      expect(typeof db.prepare).toBe('function');
      db.close();
    });

    it('initializes the database schema', () => {
      const db = createTestDb();
      try {
        // channels table should exist and be queryable
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").all();
        expect(tables).toHaveLength(1);

        const signals = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'").all();
        expect(signals).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it('has WAL journal mode enabled', () => {
      const db = createTestDb();
      try {
        const journalMode = db.pragma('journal_mode') as string;
        expect(journalMode).toBe('wal');
      } finally {
        db.close();
      }
    });

    it('has foreign keys enabled', () => {
      const db = createTestDb();
      try {
        const fkEnabled = db.pragma('foreign_keys') as number;
        expect(fkEnabled).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  describe('seedChannel', () => {
    it('inserts a channel with the given channelId', () => {
      const db = createTestDb();
      try {
        seedChannel(db, 'UCabc123');

        const row = db.prepare('SELECT channel_id, display_name FROM channels WHERE channel_id = ?').get('UCabc123') as {channel_id: string; display_name: string};
        expect(row.channel_id).toBe('UCabc123');
        expect(row.display_name).toBeDefined();
      } finally {
        db.close();
      }
    });

    it('inserts a channel with topic_id when provided', () => {
      const db = createTestDb();
      try {
        // Insert a topic first so FK constraint passes
        db.prepare("INSERT INTO topics (key, short_name, filter_text) VALUES (?, ?, ?)").run('modern', 'Modern', 'Modern format');
        seedChannel(db, 'UCtopic1', 1);

        const row = db.prepare('SELECT channel_id, topic_id FROM channels WHERE channel_id = ?').get('UCtopic1') as {channel_id: string; topic_id: number | null};
        expect(row.channel_id).toBe('UCtopic1');
        expect(row.topic_id).toBe(1);
      } finally {
        db.close();
      }
    });

    it('inserts a channel without topic_id when not provided', () => {
      const db = createTestDb();
      try {
        seedChannel(db, 'UCnoTopic');

        const row = db.prepare('SELECT channel_id, topic_id FROM channels WHERE channel_id = ?').get('UCnoTopic') as {channel_id: string; topic_id: number | null};
        expect(row.channel_id).toBe('UCnoTopic');
        expect(row.topic_id).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  describe('seedSignal', () => {
    it('inserts a signal with the given videoId and transcription', () => {
      const db = createTestDb();
      try {
        seedSignal(db, 'vid_test1', 'this is a test transcription');

        const row = db.prepare('SELECT video_id, transcription FROM signals WHERE video_id = ?').get('vid_test1') as {video_id: string; transcription: string};
        expect(row.video_id).toBe('vid_test1');
        expect(row.transcription).toBe('this is a test transcription');
      } finally {
        db.close();
      }
    });

    it('uses default channel_id when channelId not provided', () => {
      const db = createTestDb();
      try {
        seedSignal(db, 'vid_default_ch', 'text');

        const row = db.prepare('SELECT channel_id FROM signals WHERE video_id = ?').get('vid_default_ch') as {channel_id: string};
        expect(row.channel_id).toBe('UCtest');
      } finally {
        db.close();
      }
    });

    it('uses provided channelId when given', () => {
      const db = createTestDb();
      try {
        seedChannel(db, 'UCcustom');
        seedSignal(db, 'vid_custom_ch', 'text', 'UCcustom');

        const row = db.prepare('SELECT channel_id FROM signals WHERE video_id = ?').get('vid_custom_ch') as {channel_id: string};
        expect(row.channel_id).toBe('UCcustom');
      } finally {
        db.close();
      }
    });

    it('sets a default title', () => {
      const db = createTestDb();
      try {
        seedSignal(db, 'vid_title', 'text');

        const row = db.prepare('SELECT title FROM signals WHERE video_id = ?').get('vid_title') as {title: string | null};
        expect(row.title).toBeDefined();
      } finally {
        db.close();
      }
    });

    it('sets created_at timestamp', () => {
      const db = createTestDb();
      try {
        seedSignal(db, 'vid_ts', 'text');

        const row = db.prepare('SELECT created_at FROM signals WHERE video_id = ?').get('vid_ts') as {created_at: number};
        expect(row.created_at).toBeDefined();
        expect(typeof row.created_at).toBe('number');
      } finally {
        db.close();
      }
    });
  });

  describe('type safety', () => {
    it('createTestDb returns Database.Database type', () => {
      const db: Database.Database = createTestDb();
      expect(db).toBeDefined();
      db.close();
    });

    it('seedChannel accepts Database.Database as first arg', () => {
      const db: Database.Database = createTestDb();
      try {
        // This test verifies the function signature is correct by type-checking at compile time
        seedChannel(db, 'UCtype');
        expect(true).toBe(true);
      } finally {
        db.close();
      }
    });

    it('seedSignal accepts Database.Database as first arg', () => {
      const db: Database.Database = createTestDb();
      try {
        seedSignal(db, 'vid_type', 'text');
        expect(true).toBe(true);
      } finally {
        db.close();
      }
    });
  });
});