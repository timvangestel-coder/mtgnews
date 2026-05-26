import Database from 'better-sqlite3';

export interface QueryFilters {
  channelId?: string;
  topicKey?: string;
  dateFrom?: string;
  dateTo?: string;
  minSentiment?: number;
  maxSentiment?: number;
  entityMention?: string;
  includeIrrelevant?: boolean;
  offset?: number;
  limit?: number;
}

export interface SignalRow {
  video_id: string;
  channel_id: string;
  title: string | null;
  published_at: string | null;
  transcription: string;
  summary: string | null;
  overall_sentiment: number | null;
  sentiment_label: string | null;
  created_at: number;
  processed_at: number | null;
  relevance_status?: string;
}

export interface QueryResult {
  items: SignalRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface EntityTrending {
  entity_name: string;
  entity_type: string;
  mention_count: number;
  average_sentiment: number;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_OFFSET = 0;

// Map sentiment text to numeric for averaging
function sentimentToNumber(s: string): number {
  switch (s.toLowerCase()) {
    case 'positive':
      return 3;
    case 'neutral':
      return 2;
    case 'negative':
      return 1;
    default:
      return 0;
  }
}

export function querySignals(db: Database.Database, filters: QueryFilters = {}): QueryResult {
  const offset = filters.offset ?? DEFAULT_OFFSET;
  const limit = filters.limit ?? DEFAULT_LIMIT;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.channelId) {
    conditions.push('s.channel_id = ?');
    params.push(filters.channelId);
  }

  if (filters.topicKey) {
    conditions.push('s.channel_id IN (SELECT channel_id FROM channels WHERE topic_id IN (SELECT id FROM topics WHERE key = ?))');
    params.push(filters.topicKey);
  }

  if (filters.dateFrom) {
    conditions.push('s.published_at >= ?');
    params.push(filters.dateFrom);
  }

  if (filters.dateTo) {
    conditions.push('s.published_at <= ?');
    params.push(filters.dateTo);
  }

  if (filters.minSentiment !== undefined) {
    conditions.push('s.overall_sentiment >= ?');
    params.push(filters.minSentiment);
  }

  if (filters.maxSentiment !== undefined) {
    conditions.push('s.overall_sentiment <= ?');
    params.push(filters.maxSentiment);
  }

  if (filters.entityMention) {
    conditions.push('s.video_id IN (SELECT signal_video_id FROM entity_mentions WHERE entity_name = ?)');
    params.push(filters.entityMention);
  }

  // Default: exclude irrelevant signals (includeIrrelevant defaults to false)
  if (!filters.includeIrrelevant) {
    conditions.push('(s.relevance_status IS NULL OR s.relevance_status != ?)');
    params.push('irrelevant');
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countSql = `SELECT COUNT(*) as cnt FROM signals s ${whereClause}`;
  const countRow = db.prepare(countSql).get(...params) as { cnt: number } | undefined;
  const total = countRow?.cnt ?? 0;

  // Get paginated results, ordered by published_at DESC
  const selectSql = `
    SELECT s.video_id, s.channel_id, s.title, s.published_at, s.transcription,
           s.summary, s.overall_sentiment, s.sentiment_label, s.created_at, s.processed_at, s.relevance_status
    FROM signals s ${whereClause}
    ORDER BY s.published_at DESC
    LIMIT ? OFFSET ?
  `;
  const items = db.prepare(selectSql).all(...params, limit, offset) as SignalRow[];

  return { items, total, offset, limit };
}

export function getEntityTrending(db: Database.Database): EntityTrending[] {
  const rows = db.prepare(`
    SELECT
      em.entity_name,
      em.entity_type,
      COUNT(*) as mention_count,
      AVG(s.overall_sentiment) as average_sentiment
    FROM entity_mentions em
    JOIN signals s ON em.signal_video_id = s.video_id
    GROUP BY em.entity_name
    ORDER BY mention_count DESC
  `).all() as Array<{
    entity_name: string;
    entity_type: string;
    mention_count: number;
    average_sentiment: number;
  }>;

  return rows.map((r) => ({
    entity_name: r.entity_name,
    entity_type: r.entity_type,
    mention_count: r.mention_count,
    average_sentiment: Math.round(r.average_sentiment * 100) / 100,
  }));
}