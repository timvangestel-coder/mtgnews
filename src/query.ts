// NOTE: All queries reading channels/signals/entity_mentions/signal_chat/poll_run_progress must filter
// deleted rows using softDeleteFilter(alias). See ADR-0015 (issue #185).
import Database from 'better-sqlite3';
import { softDeleteFilter } from './db/soft-delete-filter';

export interface QueryFilters {
  channelId?: string;
  topicKey?: string;
  dateFrom?: string;
  dateTo?: string;
  minSentiment?: number;
  maxSentiment?: number;
  entityMention?: string;
  includeIrrelevant?: boolean;
  includeUnreviewed?: boolean;
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
  processing_state: string;
  generated_title: string | null;
  reviewed: number;
  qaAnswered: number | null;
  qaTotal: number | null;
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
    conditions.push(`s.channel_id IN (SELECT channel_id FROM channels c WHERE topic_id IN (SELECT id FROM topics WHERE key = ?) ${softDeleteFilter('c')})`);
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
    conditions.push(`s.video_id IN (SELECT signal_video_id FROM entity_mentions em WHERE entity_name = ? ${softDeleteFilter('em')})`);
    params.push(filters.entityMention);
  }

  // Default: exclude irrelevant signals (includeIrrelevant defaults to false)
  if (!filters.includeIrrelevant) {
    conditions.push("s.processing_state != ?");
    params.push('irrelevant');
  }

  // Issue #183: filter by reviewed status
  // includeUnreviewed: false -> show only unreviewed (reviewed = 0 or NULL)
  // includeUnreviewed: true or undefined -> no filtering on reviewed
  if (filters.includeUnreviewed === false) {
    conditions.push('(s.reviewed IS NULL OR s.reviewed = 0)');
  }

  const andClause = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  // Get total count
  const countSql = `SELECT COUNT(*) as cnt FROM signals s WHERE 1=1 ${softDeleteFilter('s')} ${andClause}`;
  const countRow = db.prepare(countSql).get(...params) as { cnt: number } | undefined;
  const total = countRow?.cnt ?? 0;

  // Get paginated results, ordered by published_at DESC
   // Issue #116: Q&A ratio via correlated subqueries on signal_chat
   // Issue #183: include reviewed column
   const selectSql = `
     SELECT s.video_id, s.channel_id, s.title, s.published_at, s.transcription,
            s.summary, s.overall_sentiment, s.sentiment_label, s.created_at, s.processing_state, s.generated_title, COALESCE(s.reviewed, 0) as reviewed,
            (SELECT COUNT(*) FROM signal_chat sc WHERE sc.signal_video_id = s.video_id AND sc.answer IS NOT NULL ${softDeleteFilter('sc')}) as qaAnswered,
            (SELECT COUNT(*) FROM signal_chat sc WHERE sc.signal_video_id = s.video_id ${softDeleteFilter('sc')}) as qaTotalRaw
     FROM signals s WHERE 1=1 ${softDeleteFilter('s')} ${andClause}
    ORDER BY s.published_at DESC
    LIMIT ? OFFSET ?
  `;
  const rawItems = db.prepare(selectSql).all(...params, limit, offset) as Array<SignalRow & { qaTotalRaw: number }>;

  // Convert: if 0 questions exist, both qaAnswered and qaTotal are null (template shows "—")
  const items = rawItems.map((row) => ({
    ...row,
    qaAnswered: row.qaTotalRaw > 0 ? row.qaAnswered : null,
    qaTotal: row.qaTotalRaw > 0 ? row.qaTotalRaw : null,
  })) as SignalRow[];

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
    WHERE 1=1 ${softDeleteFilter('em')} ${softDeleteFilter('s')}
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