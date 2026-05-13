import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './init-db';
import { addChannel, listChannels, removeChannel } from './watchlist';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('watchlist', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('addChannel inserts a row with channel_id and added_at', () => {
    addChannel(db, 'UC123', 'Test Channel');

    const row = db.prepare('SELECT channel_id, added_at FROM channels WHERE channel_id = ?').get('UC123');
    expect(row).toBeDefined();
    expect(row.channel_id).toBe('UC123');
    expect(typeof row.added_at).toBe('number');
    expect(row.added_at).toBeGreaterThan(0);
  });

  it('addChannel ignores duplicate channel_id without throwing', () => {
    addChannel(db, 'UC123', 'Test Channel');
    addChannel(db, 'UC123', 'Test Channel 2');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM channels WHERE channel_id = ?').get('UC123');
    expect(count.cnt).toBe(1);
  });

  it('removeChannel deletes channel without affecting signals', () => {
    addChannel(db, 'UC123', 'Test Channel');
    // insert a signal referencing this channel
    db.prepare(
      'INSERT INTO signals (video_id, channel_id, transcription, created_at) VALUES (?, ?, ?, ?)'
    ).run('vid1', 'UC123', 'transcript', Date.now());

    removeChannel(db, 'UC123');

    const channel = db.prepare('SELECT * FROM channels WHERE channel_id = ?').get('UC123');
    expect(channel).toBeUndefined();

    const signal = db.prepare('SELECT * FROM signals WHERE video_id = ?').get('vid1');
    expect(signal).toBeDefined();
    expect(signal.channel_id).toBe('UC123');
  });

  it('removeChannel handles non-existent channel_id gracefully', () => {
    expect(() => removeChannel(db, 'UC999')).not.toThrow();
  });

  it('listChannels returns all watched channels with added_at', () => {
    addChannel(db, 'UC123', 'Channel A');
    addChannel(db, 'UC456', 'Channel B');

    const channels = listChannels(db);
    expect(channels.length).toBe(2);

    const ids = channels.map((c) => c.channel_id).sort();
    expect(ids).toEqual(['UC123', 'UC456']);

    for (const ch of channels) {
      expect(typeof ch.added_at).toBe('number');
    }
  });

  it('listChannels returns empty array when no channels', () => {
    const channels = listChannels(db);
    expect(channels).toEqual([]);
  });
});