import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './init-db';
import {
  createTopic,
  listTopics,
  updateTopic,
  deleteTopic,
  getTopicById,
} from './topics';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('topics CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  describe('createTopic', () => {
    it('inserts a topic row', () => {
      createTopic(db, 'aggression', 'Aggro', 'Content about aggressive strategies');

      const topics = listTopics(db);
      expect(topics.length).toBe(1);
      expect(topics[0].key).toBe('aggression');
      expect(topics[0].short_name).toBe('Aggro');
      expect(topics[0].filter_text).toBe('Content about aggressive strategies');
    });

    it('throws on duplicate key', () => {
      createTopic(db, 'aggression', 'Aggro', 'aggro filter');

      expect(() => createTopic(db, 'aggression', 'Aggro 2', 'other')).toThrow();
    });
  });

  describe('listTopics', () => {
    it('returns all topics ordered by id ASC', () => {
      createTopic(db, 'control', 'Control', 'control filter');
      createTopic(db, 'combo', 'Combo', 'combo filter');

      const topics = listTopics(db);
      expect(topics.length).toBe(2);
      expect(topics[0].key).toBe('control');
      expect(topics[1].key).toBe('combo');
    });

    it('returns empty array when no topics', () => {
      expect(listTopics(db)).toEqual([]);
    });
  });

  describe('getTopicById', () => {
    it('returns topic by id', () => {
      createTopic(db, 'midrange', 'Midrange', 'midrange filter');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('midrange');
      const topic = getTopicById(db, row.id);

      expect(topic).toBeDefined();
      expect(topic!.key).toBe('midrange');
    });

    it('returns undefined for non-existent id', () => {
      expect(getTopicById(db, 999)).toBeUndefined();
    });
  });

  describe('updateTopic', () => {
    it('updates provided fields, leaves others unchanged', () => {
      createTopic(db, 'aggro', 'Aggro', 'old filter');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('aggro');

      updateTopic(db, row.id, { short_name: 'Aggressive' });

      const topic = getTopicById(db, row.id);
      expect(topic!.short_name).toBe('Aggressive');
      expect(topic!.key).toBe('aggro');
      expect(topic!.filter_text).toBe('old filter');
    });

    it('updates multiple fields', () => {
      createTopic(db, 'ctl', 'Control', 'old');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('ctl');

      updateTopic(db, row.id, { key: 'control', filter_text: 'new filter' });

      const topic = getTopicById(db, row.id);
      expect(topic!.key).toBe('control');
      expect(topic!.filter_text).toBe('new filter');
    });
  });

  describe('deleteTopic', () => {
    it('deletes topic and nullifies channel topic_id references', () => {
      createTopic(db, 'aggro', 'Aggro', 'aggro filter');
      const row = db.prepare('SELECT id FROM topics WHERE key = ?').get('aggro');

      // add a channel referencing this topic
      db.prepare(
        "INSERT INTO channels (channel_id, display_name, active, added_at, topic_id) VALUES (?, ?, 1, ?, ?)"
      ).run('UC123', 'Test Channel', Date.now(), row.id);

      deleteTopic(db, row.id);

      expect(getTopicById(db, row.id)).toBeUndefined();

      const channel = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get('UC123');
      expect(channel.topic_id).toBeNull();
    });

    it('handles delete of non-existent id gracefully', () => {
      expect(() => deleteTopic(db, 999)).not.toThrow();
    });
  });
});