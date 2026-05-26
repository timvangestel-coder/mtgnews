import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './init-db';
import {
  addChannel,
  listChannels,
  listActiveChannels,
  removeChannel,
  updateChannelTopic,
  toggleChannelActive,
} from './watchlist';
import { createTopic } from './topics';

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

  it('addChannel inserts a row with channel_id, added_at, and topic_id', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter text');
    addChannel(db, 'UC123', 'Test Channel', null, 1);

    const row = db.prepare(
      'SELECT channel_id, added_at, topic_id FROM channels WHERE channel_id = ?'
    ).get('UC123');
    expect(row).toBeDefined();
    expect(row.channel_id).toBe('UC123');
    expect(typeof row.added_at).toBe('number');
    expect(row.added_at).toBeGreaterThan(0);
    expect(row.topic_id).toBe(1);
  });

  it('addChannel ignores duplicate channel_id without throwing', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter text');
    addChannel(db, 'UC123', 'Test Channel', null, 1);
    addChannel(db, 'UC123', 'Test Channel 2', null, 1);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM channels WHERE channel_id = ?').get('UC123');
    expect(count.cnt).toBe(1);
  });

  it('removeChannel deletes channel without affecting signals', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter text');
    addChannel(db, 'UC123', 'Test Channel', null, 1);
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

  it('listChannels returns all watched channels with topic_id', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    createTopic(db, 'pokemon', 'Pokemon', 'Pokemon filter');
    addChannel(db, 'UC123', 'Channel A', null, 1);
    addChannel(db, 'UC456', 'Channel B', null, 2);

    const channels = listChannels(db);
    expect(channels.length).toBe(2);

    const ids = channels.map((c) => c.channel_id).sort();
    expect(ids).toEqual(['UC123', 'UC456']);

    for (const ch of channels) {
      expect(typeof ch.added_at).toBe('number');
      expect(typeof ch.topic_id).toBe('number');
    }
  });

  it('listChannels returns empty array when no channels', () => {
    const channels = listChannels(db);
    expect(channels).toEqual([]);
  });

  it('updateChannelTopic changes topic_id for a channel', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    createTopic(db, 'pokemon', 'Pokemon', 'Pokemon filter');
    addChannel(db, 'UC123', 'Test Channel', null, 1);

    updateChannelTopic(db, 'UC123', 2);

    const row = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get('UC123');
    expect(row.topic_id).toBe(2);
  });

  it('updateChannelTopic sets topic_id to null', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC123', 'Test Channel', null, 1);

    updateChannelTopic(db, 'UC123', null);

    const row = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get('UC123');
    expect(row.topic_id).toBeNull();
  });

  it('listActiveChannels excludes inactive channels', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC123', 'Active Channel', null, 1);
    addChannel(db, 'UC456', 'Inactive Channel', null, 1);
    toggleChannelActive(db, 'UC456', false);

    const active = listActiveChannels(db);
    expect(active.length).toBe(1);
    expect(active[0].channel_id).toBe('UC123');
  });

  it('listActiveChannels excludes channels with NULL topic_id', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC123', 'With Topic', null, 1);
    // Add channel with null topic_id
    addChannel(db, 'UC456', 'No Topic', null, null as unknown as number);

    const active = listActiveChannels(db);
    expect(active.length).toBe(1);
    expect(active[0].channel_id).toBe('UC123');
  });

  it('listActiveChannels requires both active=1 AND topic_id NOT NULL', () => {
    createTopic(db, 'mtg', 'MTG', 'MTG filter');
    addChannel(db, 'UC123', 'Full Active', null, 1);
    // Active but no topic
    addChannel(db, 'UC456', 'No Topic', null, null as unknown as number);
    // Has topic but inactive
    addChannel(db, 'UC789', 'Inactive', null, 1);
    toggleChannelActive(db, 'UC789', false);

    const active = listActiveChannels(db);
    expect(active.length).toBe(1);
    expect(active[0].channel_id).toBe('UC123');
  });
});