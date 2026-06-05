import Database from 'better-sqlite3';
import { initDb } from '../../src/db/init-db';

/**
 * Creates an in-memory SQLite database with the full schema initialized.
 * @returns a ready-to-use Database.Database instance
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

/**
 * Inserts a channel row into the test database.
 * @param db - the database instance
 * @param channelId - the YouTube channel ID
 * @param topicId - optional topic_id foreign key
 */
export function seedChannel(db: Database.Database, channelId: string, topicId?: number): void {
  if (topicId !== undefined) {
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at, topic_id) VALUES (?, ?, ?, ?)'
    ).run(channelId, 'Test Channel', Date.now(), topicId);
  } else {
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run(channelId, 'Test Channel', Date.now());
  }
}

/**
 * Inserts a signal row into the test database with sensible defaults.
 * @param db - the database instance
 * @param videoId - the YouTube video ID
 * @param transcription - the transcription text or JSON string
 * @param channelId - optional channel_id (defaults to 'UCtest')
 */
export function seedSignal(db: Database.Database, videoId: string, transcription: string, channelId: string = 'UCtest'): void {
  db.prepare(
    'INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(videoId, channelId, 'Test Video', transcription, Date.now());
}