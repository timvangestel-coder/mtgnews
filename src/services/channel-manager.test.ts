import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db/init-db';
import { listChannels, getChannelLastPollDate, createTopic } from '../db/watchlist';
import { ChannelManager } from './channel-manager';

vi.mock('../rss-discovery', () => ({
  resolveChannelId: vi.fn(),
  fetchChannelInfo: vi.fn(),
}));

import { resolveChannelId, fetchChannelInfo } from '../rss-discovery';

let db: Database.Database;
let manager: ChannelManager;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  // Create test topics so topic_id FK constraints pass
  createTopic(db, 'test-topic-a', 'Topic A', '');
  createTopic(db, 'test-topic-b', 'Topic B', '');
  createTopic(db, 'test-topic-c', 'Topic C', '');
  manager = new ChannelManager(db);
});

afterAll(() => {
  db.close();
});

describe('ChannelManager', () => {
  describe('addChannelWithInfo()', () => {
    it('adds channel with resolved id and fetched info', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCresolved${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue({
        display_name: 'Fetched Name',
        avatar_url: 'https://avatar.png',
      });

      await manager.addChannelWithInfo('@somehandle', null);

      const channels = listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].channel_id).toBe(`UCresolved${t}`);
      expect(channels[0].display_name).toBe('Fetched Name');
      expect(channels[0].avatar_url).toBe('https://avatar.png');
      expect(channels[0].active).toBe(1);
    });

    it('stores with empty info when rss fetch fails', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCfallback${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@failhandle', null);

      const channels = listChannels(db);
      const ch = channels.find((c) => c.channel_id === `UCfallback${t}`);
      expect(ch).toBeDefined();
      expect(ch!.display_name).toBeNull();
      expect(ch!.avatar_url).toBeNull();
    });

    it('uses raw input when resolution fails', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockRejectedValue(new Error('cannot resolve'));
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo(`UCraw${t}`, null);

      const channels = listChannels(db);
      const ch = channels.find((c) => c.channel_id === `UCraw${t}`);
      expect(ch).toBeDefined();
    });

    it('associates channel with topic_id when provided', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCTopic${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@topicchan', 2);

      const channels = listChannels(db);
      const ch = channels.find((c) => c.channel_id === `UCTopic${t}`);
      expect(ch!.topic_id).toBe(2);
    });
  });

  describe('removeChannel()', () => {
    it('removes channel from database', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCremove${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@removechan', null);
      expect(listChannels(db).length).toBeGreaterThan(0);

      manager.removeChannel(`UCremove${t}`);

      const remaining = listChannels(db).filter((c) => c.channel_id === `UCremove${t}`);
      expect(remaining.length).toBe(0);
    });
  });

  describe('toggleActive()', () => {
    it('sets active to false when toggled off', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCtoggle${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@togglechan', null);
      let ch = listChannels(db).find((c) => c.channel_id === `UCtoggle${t}`);
      expect(ch!.active).toBe(1);

      manager.toggleActive(`UCtoggle${t}`, false);

      ch = listChannels(db).find((c) => c.channel_id === `UCtoggle${t}`);
      expect(ch!.active).toBe(0);
    });

    it('sets active to true when toggled on', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCtoggle2${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@togglechan2', null);
      manager.toggleActive(`UCtoggle2${t}`, false);

      manager.toggleActive(`UCtoggle2${t}`, true);

      const ch = listChannels(db).find((c) => c.channel_id === `UCtoggle2${t}`);
      expect(ch!.active).toBe(1);
    });
  });

  describe('updateTopic()', () => {
    it('updates channel topic_id', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCtopic${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@updatechan', null);
      let ch = listChannels(db).find((c) => c.channel_id === `UCtopic${t}`);
      expect(ch!.topic_id).toBeNull();

      manager.updateTopic(`UCtopic${t}`, 3);

      ch = listChannels(db).find((c) => c.channel_id === `UCtopic${t}`);
      expect(ch!.topic_id).toBe(3);
    });

    it('clears topic_id when set to null', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UCtopicClear${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue(null);

      await manager.addChannelWithInfo('@clearchan', 1);
      let ch = listChannels(db).find((c) => c.channel_id === `UCtopicClear${t}`);
      expect(ch!.topic_id).toBe(1);

      manager.updateTopic(`UCtopicClear${t}`, null);

      ch = listChannels(db).find((c) => c.channel_id === `UCtopicClear${t}`);
      expect(ch!.topic_id).toBeNull();
    });
  });

  describe('listAll()', () => {
    it('returns channels with last_poll_date', async () => {
      const t = Date.now();
      vi.mocked(resolveChannelId).mockResolvedValue(`UClist${t}`);
      vi.mocked(fetchChannelInfo).mockResolvedValue({
        display_name: 'List Name',
        avatar_url: '',
      });

      await manager.addChannelWithInfo('@listchan', null);

      const result = manager.listAll();
      const ch = result.find((c) => c.channel_id === `UClist${t}`);
      expect(ch).toBeDefined();
      expect(ch!.display_name).toBe('List Name');
      expect(ch!.last_poll_date).toBeNull();
    });
  });
});