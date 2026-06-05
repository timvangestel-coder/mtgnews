import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addChannel,
  removeChannel,
  toggleChannelActive,
  listChannels,
  updateChannelTopic,
  getChannelLastPollDate,
  createTopic,
  listTopics,
  getTopicById,
  updateTopic,
  deleteTopic,
  getChannelsWithTopics,
  listActiveChannels,
  getAdminData,
} from './watchlist';
import { createTestDb } from '../../tests/fixtures/test-db';

describe('watchlist module', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  describe('Channel CRUD', () => {
    it('addChannel inserts a channel row', () => {
      addChannel(db, 'UC1', 'Channel 1');

      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].channel_id).toBe('UC1');
      expect(channels[0].active).toBe(1);
    });

    it('addChannel with topic_id persists linkage', () => {
      createTopic(db, 'mtg', 'MTG', 'filter');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('mtg') as { id: number };
      addChannel(db, 'UC2', 'Channel 2', undefined, row.id);

      const ch = listChannels(db).find((c) => c.channel_id === 'UC2');
      expect(ch!.topic_id).toBe(row.id);
    });

    it('removeChannel deletes channel and related signals/mentions in transaction', () => {
      addChannel(db, 'UC3', 'Remove Me');
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run('v1', 'UC3', 'Title', '2026-01-01T00:00:00Z', '[]', Date.now());
      db.prepare(
        "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
      ).run('v1', 'entity');

      removeChannel(db, 'UC3');

      expect(listChannels(db).find((c) => c.channel_id === 'UC3')).toBeUndefined();
      const sigCount = (db.prepare("SELECT COUNT(*) as c FROM signals WHERE channel_id = ?").get('UC3') as { c: number }).c;
      expect(sigCount).toBe(0);
      const emCount = (db.prepare("SELECT COUNT(*) as c FROM entity_mentions").get() as { c: number }).c;
      expect(emCount).toBe(0);
    });

    it('toggleChannelActive flips active flag', () => {
      addChannel(db, 'UC4', 'Toggle Me');
      toggleChannelActive(db, 'UC4', false);

      const ch = listChannels(db).find((c) => c.channel_id === 'UC4');
      expect(ch!.active).toBe(0);
    });

    it('updateChannelTopic changes topic_id', () => {
      createTopic(db, 't1', 'T1', 'f1');
      createTopic(db, 't2', 'T2', 'f2');
      const t2row = db.prepare('SELECT id FROM topics WHERE key = ?').get('t2') as { id: number };

      addChannel(db, 'UC5', 'Update Topic Ch');
      updateChannelTopic(db, 'UC5', t2row.id);

      const ch = listChannels(db).find((c) => c.channel_id === 'UC5');
      expect(ch!.topic_id).toBe(t2row.id);
    });

    it('getChannelLastPollDate returns null when no poll progress', () => {
      addChannel(db, 'UC6', 'No Poll Ch');
      const last = getChannelLastPollDate(db, 'UC6');
      expect(last).toBeNull();
    });

    it('getChannelLastPollDate returns max updated_at from poll_run_progress', () => {
      addChannel(db, 'UC7', 'Poll Ch');
      db.prepare(
        "INSERT INTO poll_run_progress (channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?)"
      ).run('UC7', 'done', 2, 1000);
      db.prepare(
        "INSERT INTO poll_run_progress (channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?)"
      ).run('UC7', 'done', 3, 2000);

      const last = getChannelLastPollDate(db, 'UC7');
      expect(last).toBe(2000);
    });
  });

  describe('Topic CRUD', () => {
    it('createTopic inserts a topic row', () => {
      createTopic(db, 'aggression', 'Aggro', 'Content about aggressive strategies');

      const topics = listTopics(db);
      expect(topics.length).toBe(1);
      expect(topics[0].key).toBe('aggression');
    });

    it('createTopic throws on duplicate key', () => {
      createTopic(db, 'aggro', 'Aggro', 'filter');
      expect(() => createTopic(db, 'aggro', 'Aggro 2', 'other')).toThrow();
    });

    it('listTopics returns all topics ordered by id ASC', () => {
      createTopic(db, 'control', 'Control', 'f1');
      createTopic(db, 'combo', 'Combo', 'f2');

      const topics = listTopics(db);
      expect(topics.length).toBe(2);
      expect(topics[0].key).toBe('control');
      expect(topics[1].key).toBe('combo');
    });

    it('getTopicById returns topic or undefined', () => {
      createTopic(db, 'midrange', 'Midrange', 'f3');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('midrange') as { id: number };
      expect(getTopicById(db, row.id)!.key).toBe('midrange');
      expect(getTopicById(db, 999)).toBeUndefined();
    });

    it('updateTopic updates provided fields only', () => {
      createTopic(db, 'ctl', 'Control', 'old filter');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('ctl') as { id: number };

      updateTopic(db, row.id, { short_name: 'Updated Control' });

      const t = getTopicById(db, row.id);
      expect(t!.short_name).toBe('Updated Control');
      expect(t!.filter_text).toBe('old filter');
    });

    it('deleteTopic deletes topic and nullifies channel references', () => {
      createTopic(db, 'del', 'Delete Me', 'f4');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('del') as { id: number };
      addChannel(db, 'UC8', 'Del Ch', undefined, row.id);

      deleteTopic(db, row.id);

      expect(getTopicById(db, row.id)).toBeUndefined();
      const ch = listChannels(db).find((c) => c.channel_id === 'UC8');
      expect(ch!.topic_id).toBeNull();
    });
  });

  describe('Deep queries', () => {
    it('getChannelsWithTopics returns channels with topic_key from LEFT JOIN', () => {
      createTopic(db, 'mtg', 'MTG', 'f5');
      const trow = db.prepare('SELECT id FROM topics WHERE key = ?').get('mtg') as { id: number };

      addChannel(db, 'UC9', 'With Topic Ch', undefined, trow.id);
      addChannel(db, 'UC10', 'No Topic Ch');

      const channels = getChannelsWithTopics(db);
      expect(channels.length).toBe(2);

      const withT = channels.find((c) => c.channel_id === 'UC9');
      expect(withT!.topic_key).toBe('mtg');

      const noT = channels.find((c) => c.channel_id === 'UC10');
      expect(noT!.topic_key).toBeNull();
    });

    it('listActiveChannels returns only active channels with non-null topic', () => {
      createTopic(db, 'active-t', 'Active T', 'f6');
      const trow = db.prepare('SELECT id FROM topics WHERE key = ?').get('active-t') as { id: number };

      addChannel(db, 'UC11', 'Active With Topic', undefined, trow.id);
      addChannel(db, 'UC12', 'Inactive', undefined, trow.id);
      toggleChannelActive(db, 'UC12', false);
      addChannel(db, 'UC13', 'No Topic Active');

      const channels = listActiveChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].channel_id).toBe('UC11');
    });

    it('getAdminData returns channels with last_poll_date and topics with channel_count', () => {
      createTopic(db, 'admin-t', 'Admin T', 'f7');
      const trow = db.prepare('SELECT id FROM topics WHERE key = ?').get('admin-t') as { id: number };

      addChannel(db, 'UC14', 'Admin Ch 1', undefined, trow.id);
      addChannel(db, 'UC15', 'Admin Ch 2', undefined, trow.id);
      addChannel(db, 'UC16', 'No Topic');

      // Insert poll progress for UC14
      db.prepare(
        "INSERT INTO poll_run_progress (channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?)"
      ).run('UC14', 'done', 3, 5000);

      const data = getAdminData(db);

      // Channels: UC14 has last_poll_date, others null
      expect(data.channels.length).toBe(3);
      const ch14 = data.channels.find((c) => c.channel_id === 'UC14');
      expect(ch14!.last_poll_date).toBe(5000);
      expect(ch14!.topic_key).toBe('admin-t');

      const ch16 = data.channels.find((c) => c.channel_id === 'UC16');
      expect(ch16!.last_poll_date).toBeNull();
      expect(ch16!.topic_key).toBeNull();

      // Topics: admin-t has channel_count=2
      expect(data.topics.length).toBe(1);
      expect(data.topics[0].channel_count).toBe(2);
    });

    it('getAdminData handles empty state', () => {
      const data = getAdminData(db);
      expect(data.channels).toEqual([]);
      expect(data.topics).toEqual([]);
    });
  });
});