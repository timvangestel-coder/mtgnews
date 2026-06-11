import Database from 'better-sqlite3';
import { querySignals, QueryFilters, SignalRow } from '../query';
import { getSignalById, formatTranscriptionHtml } from '../signal-detail';
import { ChatResponseFormatter } from '../chat-response-formatter';
import { analyzeSignal, getLlmConfig, AnalysisResult } from '../llm';
import { getChannelsWithTopics } from '../db/watchlist';

export interface ListSignalsOptions {
  channelId?: string;
  topicKey?: string;
  includeIrrelevant?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListSignalsResult {
  items: SignalRow[];
  total: number;
}

export interface SignalDetailResult {
  signal: SignalRow;
  channel: any;
  summaryHtml: string;
  transcriptionHtml: string;
}

export class SignalQueryService {
  constructor(private db: Database.Database) {}

  get database(): Database.Database {
    return this.db;
  }

  listSignals(options: ListSignalsOptions = {}): ListSignalsResult {
    const filters: QueryFilters = {
      channelId: options.channelId,
      topicKey: options.topicKey,
      includeIrrelevant: options.includeIrrelevant,
      limit: options.limit,
      offset: options.offset,
    };

    return querySignals(this.db, filters);
  }

  getSignalDetail(videoId: string): SignalDetailResult | null {
    const signal = getSignalById(this.db, videoId);
    if (!signal) {
      return null;
    }

    const channels = getChannelsWithTopics(this.db);
    const channel = channels.find((c: any) => c.channel_id === signal.channel_id);
    const summaryHtml = signal.summary ? ChatResponseFormatter.format(signal.summary, {}) : '';
    const transcriptionHtml = formatTranscriptionHtml(signal.transcription);

    return { signal, channel, summaryHtml, transcriptionHtml };
  }

  async summarizeSignal(videoId: string): Promise<AnalysisResult> {
    // Check signal exists first
    const sigRow = this.db.prepare('SELECT video_id FROM signals WHERE video_id = ?').get(videoId);
    if (!sigRow) {
      return { success: false, error: `Signal ${videoId} not found` };
    }

    const config = getLlmConfig();
    return analyzeSignal(this.db, videoId, config);
  }
}