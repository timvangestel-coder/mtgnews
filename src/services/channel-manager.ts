import Database from 'better-sqlite3';
import { addChannel, removeChannel as dbRemoveChannel, toggleChannelActive as dbToggleActive, updateChannelTopic as dbUpdateTopic, listChannels, getChannelLastPollDate } from '../db/watchlist';
import { resolveChannelId, fetchChannelInfo } from '../rss-discovery';

export interface ChannelWithDetails {
  channel_id: string;
  display_name: string | null;
  avatar_url: string | null;
  active: number;
  added_at: number;
  topic_id: number | null;
  last_poll_date: number | null;
}

export class ChannelManager {
  constructor(private db: Database.Database) {}

  async addChannelWithInfo(rawInput: string, topicId: number | null): Promise<void> {
    // Resolve handle/URL to UC ID
    let channelId: string;
    try {
      channelId = await resolveChannelId(rawInput);
    } catch {
      channelId = rawInput;
    }

    // Try to fetch channel info from RSS
    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    try {
      const info = await fetchChannelInfo(channelId);
      if (info) {
        displayName = info.display_name || undefined;
        avatarUrl = info.avatar_url || undefined;
      }
    } catch {
      // ignore fetch errors, store with empty info
    }

    addChannel(this.db, channelId, displayName, avatarUrl, topicId ?? undefined);
  }

  removeChannel(channelId: string): void {
    dbRemoveChannel(this.db, channelId);
  }

  toggleActive(channelId: string, active: boolean): void {
    dbToggleActive(this.db, channelId, active);
  }

  updateTopic(channelId: string, topicId: number | null): void {
    dbUpdateTopic(this.db, channelId, topicId);
  }

  listAll(): ChannelWithDetails[] {
    const channels = listChannels(this.db);
    return channels.map((ch) => ({
      ...ch,
      last_poll_date: getChannelLastPollDate(this.db, ch.channel_id),
    }));
  }
}