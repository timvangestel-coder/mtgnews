import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../db/init-db';
import { createTopic as dbCreateTopic, listTopics, getTopicById, updateTopic as dbUpdateTopic, deleteTopic as dbDeleteTopic, addChannel } from '../db/watchlist';
import { TopicManager } from './topic-manager';

let db: Database.Database;
let manager: TopicManager;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  manager = new TopicManager(db);
});

afterAll(() => {
  db.close();
});

describe('TopicManager', () => {
  describe('create()', () => {
    it('creates a topic with key, short_name, and filter_text', () => {
      const t = Date.now();
      manager.create(`topic-key-${t}`, `Topic ${t}`, 'filter text');

      const topics = manager.listWithCounts();
      const found = topics.find((tp) => tp.key === `topic-key-${t}`);
      expect(found).toBeDefined();
      expect(found!.short_name).toBe(`Topic ${t}`);
      expect(found!.filter_text).toBe('filter text');
    });

    it('creates a topic with summary_prompt', () => {
      const t = Date.now();
      const prompt = 'Custom template: {TRANSCRIPTION}';
      manager.create(`prompt-${t}`, `Prompt Topic ${t}`, 'filter', prompt);

      const topics = manager.listWithCounts();
      const found = topics.find((tp) => tp.key === `prompt-${t}`);
      expect(found).toBeDefined();
      expect(found!.summary_prompt).toBe(prompt);
    });

    it('creates a topic with NULL summary_prompt when not provided', () => {
      const t = Date.now();
      manager.create(`no-prompt-${t}`, `No Prompt ${t}`, 'filter');

      const topics = manager.listWithCounts();
      const found = topics.find((tp) => tp.key === `no-prompt-${t}`);
      expect(found).toBeDefined();
      expect(found!.summary_prompt).toBeNull();
    });

    it('throws on duplicate key', () => {
      const t = Date.now();
      manager.create(`unique-${t}`, 'First', '');

      expect(() => manager.create(`unique-${t}`, 'Second', '')).toThrow();
    });
  });

  describe('update()', () => {
    it('updates key, short_name, and filter_text', () => {
      const t = Date.now();
      dbCreateTopic(db, `upd-${t}`, 'Before', 'old');
      const topic = listTopics(db).find((tp) => tp.key === `upd-${t}`)!;

      manager.update(topic.id, { key: `upd-${t}-new`, short_name: 'After', filter_text: 'new' });

      const updated = getTopicById(db, topic.id);
      expect(updated!.key).toBe(`upd-${t}-new`);
      expect(updated!.short_name).toBe('After');
      expect(updated!.filter_text).toBe('new');
    });

    it('updates summary_prompt', () => {
      const t = Date.now();
      dbCreateTopic(db, `updprompt-${t}`, 'Prompt Update', 'old filter');
      const topic = listTopics(db).find((tp) => tp.key === `updprompt-${t}`)!;

      manager.update(topic.id, { summary_prompt: 'New custom template' });

      const updated = getTopicById(db, topic.id);
      expect(updated!.summary_prompt).toBe('New custom template');
    });

    it('sets summary_prompt to null', () => {
      const t = Date.now();
      manager.create(`nullprompt-${t}`, 'Null Prompt', 'filter', 'existing prompt');
      const topic = listTopics(db).find((tp) => tp.key === `nullprompt-${t}`)!;

      manager.update(topic.id, { summary_prompt: null });

      const updated = getTopicById(db, topic.id);
      expect(updated!.summary_prompt).toBeNull();
    });

    it('updates only provided fields', () => {
      const t = Date.now();
      dbCreateTopic(db, `partial-${t}`, 'Original Name', 'original filter');
      const topic = listTopics(db).find((tp) => tp.key === `partial-${t}`)!;

      manager.update(topic.id, { short_name: 'Changed Name' });

      const updated = getTopicById(db, topic.id);
      expect(updated!.key).toBe(`partial-${t}`);
      expect(updated!.short_name).toBe('Changed Name');
      expect(updated!.filter_text).toBe('original filter');
    });

    it('does nothing when no fields provided', () => {
      const t = Date.now();
      dbCreateTopic(db, `noop-${t}`, 'Noop', 'noop filter');
      const topic = listTopics(db).find((tp) => tp.key === `noop-${t}`)!;

      manager.update(topic.id, {});

      const updated = getTopicById(db, topic.id);
      expect(updated!.short_name).toBe('Noop');
    });
  });

  describe('delete()', () => {
    it('deletes the topic', () => {
      const t = Date.now();
      dbCreateTopic(db, `del-${t}`, 'Delete Me', '');
      const topic = listTopics(db).find((tp) => tp.key === `del-${t}`)!;

      manager.delete(topic.id);

      const found = getTopicById(db, topic.id);
      expect(found).toBeUndefined();
    });

    it('force-delete sets channel topic_id to NULL without deleting channels', () => {
      const t = Date.now();
      dbCreateTopic(db, `forcedel-${t}`, 'Force Del', '');
      const topic = listTopics(db).find((tp) => tp.key === `forcedel-${t}`)!;

      addChannel(db, `UC_force_${t}`, 'Force Channel', undefined, topic.id);
      const channelBefore = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get(`UC_force_${t}`) as { topic_id: number | null };
      expect(channelBefore.topic_id).toBe(topic.id);

      manager.delete(topic.id);

      // Topic is gone
      expect(getTopicById(db, topic.id)).toBeUndefined();

      // Channel still exists but topic_id is NULL
      const channelAfter = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get(`UC_force_${t}`) as { topic_id: number | null };
      expect(channelAfter.topic_id).toBeNull();
    });
  });

  describe('listWithCounts()', () => {
    it('returns topics with channel_count', () => {
      const t = Date.now();
      dbCreateTopic(db, `count1-${t}`, 'Count One', '');
      dbCreateTopic(db, `count2-${t}`, 'Count Two', '');
      const topic1 = listTopics(db).find((tp) => tp.key === `count1-${t}`)!;
      const topic2 = listTopics(db).find((tp) => tp.key === `count2-${t}`)!;

      addChannel(db, `UC_count_a_${t}`, 'Ch A', undefined, topic1.id);
      addChannel(db, `UC_count_b_${t}`, 'Ch B', undefined, topic1.id);
      addChannel(db, `UC_count_c_${t}`, 'Ch C', undefined, topic2.id);

      const result = manager.listWithCounts();
      const t1 = result.find((tp) => tp.key === `count1-${t}`);
      const t2 = result.find((tp) => tp.key === `count2-${t}`);

      expect(t1!.channel_count).toBe(2);
      expect(t2!.channel_count).toBe(1);
    });

    it('returns empty array when no topics exist', () => {
      // Create a fresh DB with no topics
      const freshDb = new Database(':memory:');
      initDb(freshDb);
      const freshManager = new TopicManager(freshDb);

      const result = freshManager.listWithCounts();
      expect(result).toEqual([]);

      freshDb.close();
    });
  });
});