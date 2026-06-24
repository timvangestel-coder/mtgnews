import Database from 'better-sqlite3';
import { SignalContext } from './signal-context';
import type { SignalIndexEntry } from './prompt-assembler';

/**
 * Describes the scope of a multi-signal chat session.
 * - videoId: single-signal chat (existing behavior)
 * - topicKey: all signals under a topic
 * - channelId: narrow to one channel within a topic
 * - includeIrrelevant: also include signals with processing_state='irrelevant'
 * - dateFilter: filter signals by date range preset ('today'|'week'|'month'|'all')
 */
export interface ChatScope {
  videoId?: string;
  topicKey?: string;
  channelId?: string;
  includeIrrelevant?: boolean;
  question?: string;
  dateFilter?: string;
}

/**
 * Wraps SignalContext with display metadata for a single signal in the chat scope.
 */
export interface ChatSignalContext {
  signalContext: SignalContext;
  videoId: string;
  title: string;
  channelDisplayName: string;
  summary: string;
  compactText?: string;
}

/**
 * Resolves all signals matching the given scope criteria.
 * Returns ChatSignalContext[] with transcriptions, summaries, and display metadata.
 *
 * Scope resolution rules:
 * - videoId set → single signal
 * - topicKey set → all signals in that topic (optionally filtered by channelId)
 * - neither set → all signals (no-filters scope)
 * - includeIrrelevant=false (default) → exclude processing_state='irrelevant'
 */
export function resolveScope(db: Database.Database, scope: ChatScope): ChatSignalContext[] {
  // Single-video scope
  if (scope.videoId) {
    const row = db.prepare(`
      SELECT s.video_id, s.transcription, s.summary, s.compact_text, t.id AS topic_id, t.filter_text, t.summary_prompt,
             c.display_name AS channel_display_name, s.title
      FROM signals s
      JOIN channels c ON s.channel_id = c.channel_id
      LEFT JOIN topics t ON c.topic_id = t.id
      WHERE s.video_id = ?
    `).get(scope.videoId) as
      | {
          video_id: string;
          transcription: string;
          summary: string | null;
          compact_text: string | null;
          topic_id: number | null;
          filter_text: string | null;
          summary_prompt: string | null;
          channel_display_name: string;
          title: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`Signal ${scope.videoId} not found`);
    }

    return [
      {
        signalContext: {
          transcriptionJson: row.transcription,
          topicId: row.topic_id ?? 0,
          filterText: row.filter_text ?? '',
          summaryPrompt: row.summary_prompt ?? null,
        },
        videoId: row.video_id,
        title: row.title,
        channelDisplayName: row.channel_display_name,
        summary: row.summary ?? '',
        compactText: row.compact_text ?? undefined,
      },
    ];
  }

  // Multi-signal scope (topic-based or no-filters)
  const conditions: string[] = [];
  const params: (string | number | boolean)[] = [];

  // Filter by topic if specified
  if (scope.topicKey) {
    conditions.push('t.key = ?');
    params.push(scope.topicKey);
  }

  // Filter by channel if specified
  if (scope.channelId) {
    conditions.push('c.channel_id = ?');
    params.push(scope.channelId);
  }

  // Exclude irrelevant signals unless includeIrrelevant is true
  if (!scope.includeIrrelevant) {
    conditions.push("s.processing_state != 'irrelevant'");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT s.video_id, s.transcription, s.summary, s.compact_text, t.id AS topic_id, t.filter_text, t.summary_prompt,
           c.display_name AS channel_display_name, s.title
    FROM signals s
    JOIN channels c ON s.channel_id = c.channel_id
    LEFT JOIN topics t ON c.topic_id = t.id
    ${whereClause}
    ORDER BY s.published_at DESC
  `).all(...params) as Array<{
    video_id: string;
    transcription: string;
    summary: string | null;
    compact_text: string | null;
    topic_id: number | null;
    filter_text: string | null;
    summary_prompt: string | null;
    channel_display_name: string;
    title: string;
  }>;

  return rows.map((row) => ({
    signalContext: {
      transcriptionJson: row.transcription,
      topicId: row.topic_id ?? 0,
      filterText: row.filter_text ?? '',
      summaryPrompt: row.summary_prompt ?? null,
    },
    videoId: row.video_id,
    title: row.title,
    channelDisplayName: row.channel_display_name,
    summary: row.summary ?? '',
    compactText: row.compact_text ?? undefined,
  }));
}

// ─── AgentChat lightweight index (issue #163) ──────────────────────

/** Optional date filter for signal queries. */
export interface DateFilterOptions {
  /** Only include signals with published_at >= dateFrom. */
  dateFrom?: string;
}

/**
 * Resolves a lightweight signal index for AgentChat scope resolution.
 * Returns only { videoId, title, summary } per signal — no compact_text, no transcription.
 * Uses the same scope resolution rules as resolveScope().
 */
export function resolveIndexScope(db: Database.Database, scope: ChatScope, dateOptions?: DateFilterOptions): SignalIndexEntry[] {
  // Single-video scope
  if (scope.videoId) {
    const row = db.prepare(`
      SELECT s.video_id, s.summary, s.title
      FROM signals s
      WHERE s.video_id = ?
    `).get(scope.videoId) as
      | { video_id: string; summary: string | null; title: string }
      | undefined;

    if (!row) {
      throw new Error(`Signal ${scope.videoId} not found`);
    }

    return [
      {
        videoId: row.video_id,
        title: row.title,
        summary: row.summary ?? '',
      },
    ];
  }

  // Multi-signal scope (topic-based or no-filters)
  const conditions: string[] = [];
  const params: (string | number | boolean)[] = [];

  if (scope.topicKey) {
    conditions.push('t.key = ?');
    params.push(scope.topicKey);
  }

  if (scope.channelId) {
    conditions.push('c.channel_id = ?');
    params.push(scope.channelId);
  }

  if (!scope.includeIrrelevant) {
    conditions.push("s.processing_state != 'irrelevant'");
  }

  // Issue #181: date filtering
  if (dateOptions?.dateFrom) {
    conditions.push('s.published_at >= ?');
    params.push(dateOptions.dateFrom);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT s.video_id, s.summary, s.title
    FROM signals s
    JOIN channels c ON s.channel_id = c.channel_id
    LEFT JOIN topics t ON c.topic_id = t.id
    ${whereClause}
    ORDER BY s.published_at DESC
  `).all(...params) as Array<{ video_id: string; summary: string | null; title: string }>;

  return rows.map((row) => ({
    videoId: row.video_id,
    title: row.title,
    summary: row.summary ?? '',
  }));
}