import Database from 'better-sqlite3';
import { LlmConfig, callLlmStream, callLlmSync } from '../llm';
import { assembleChat, assembleMultiSignalChat, defaultMultiSignalChatPromptTemplate } from '../prompt-assembler';
import { ChatScope, resolveScope, ChatSignalContext } from '../signal-chat-scope';
import { ChatResponseFormatter } from '../chat-response-formatter';
import { getAppSetting } from '../db/app-settings';

export interface ChatMessage {
  id: number;
  signal_video_id: string | null;
  question: string;
  answer: string | null;
  is_formatted: number;
  created_at: string;
}

/**
 * Input for getHistory — either a legacy signalVideoId string or a ChatScope object.
 */
export type HistoryFilter = string | ChatScope;

/**
 * Resolves signal transcription, summary, and topic filter_text for chat context.
 */
function resolveSignalForChat(db: Database.Database, videoId: string): { transcriptionJson: string; summary: string; filterText?: string } | null {
  const row = db.prepare(`
    SELECT s.transcription, s.summary, t.filter_text
    FROM signals s
    LEFT JOIN channels c ON s.channel_id = c.channel_id
    LEFT JOIN topics t ON c.topic_id = t.id
    WHERE s.video_id = ?
  `).get(videoId) as { transcription: string; summary: string | null; filter_text?: string } | undefined;

  if (!row) return null;
  return {
    transcriptionJson: row.transcription,
    summary: row.summary ?? '',
    filterText: row.filter_text || undefined,
  };
}

export class ChatManager {
  constructor(
    private db: Database.Database,
    private llmConfig: LlmConfig
  ) {}

  /**
   * Returns recent Q&A pairs, ordered by created_at DESC. Default limit is 10.
   *
   * Accepts either:
   * - a signalVideoId string (legacy per-signal chat)
   * - a ChatScope object with topicKey/channelId (list-scoped chat)
   *
   * Strict composite: each unique filter combo = separate conversation history.
   */
  getHistory(filter: HistoryFilter, limit: number = 10): ChatMessage[] {
    // Legacy: string = signalVideoId
    if (typeof filter === 'string') {
      return this.db.prepare(`
        SELECT id, signal_video_id, question, answer, COALESCE(is_formatted, 0) AS is_formatted, created_at
        FROM signal_chat
        WHERE signal_video_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filter, limit) as ChatMessage[];
    }

    // ChatScope: build dynamic WHERE from filter criteria
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Normalize empty strings to undefined — prevents matching rows where
    // topic_key IS NULL against a query for topic_key = ''
    const effectiveTopicKey = (filter.topicKey === '' || filter.topicKey === null) ? undefined : filter.topicKey;
    const effectiveChannelId = (filter.channelId === '') ? undefined : filter.channelId;

    if (effectiveTopicKey !== undefined) {
      conditions.push('topic_key = ?');
      params.push(effectiveTopicKey);
    }

    if (effectiveChannelId !== undefined) {
      conditions.push('channel_id = ?');
      params.push(effectiveChannelId);
    }

    // If both topicKey and channelId are missing but videoId is set, fall back to signal_video_id
    if (conditions.length === 0 && filter.videoId) {
      conditions.push('signal_video_id = ?');
      params.push(filter.videoId);
    }

    // If still no conditions (empty scope {}), match rows that are also list-scoped
    // (topic_key IS NOT NULL OR channel_id IS NOT NULL)
    if (conditions.length === 0) {
      conditions.push('(topic_key IS NOT NULL OR channel_id IS NOT NULL)');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);

    return this.db.prepare(`
      SELECT id, signal_video_id, question, answer, COALESCE(is_formatted, 0) AS is_formatted, created_at
      FROM signal_chat
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as ChatMessage[];
  }

  /**
   * Streams an LLM answer to a question about a signal.
   * Uses tee pattern: tokens yield to caller in real-time,
   * buffer writes to DB on stream completion (only if no error).
   *
   * @param transform - optional function applied to the full answer text;
   *   transformed tokens are yielded during streaming and the transformed
   *   answer is persisted. When omitted, raw tokens pass through unchanged.
   */
  async *ask(signalVideoId: string, question: string, transform?: (text: string) => string): AsyncGenerator<string> {
    // Resolve signal context
    const signal = resolveSignalForChat(this.db, signalVideoId);
    if (!signal) {
      throw new Error(`Signal ${signalVideoId} not found`);
    }

    // Fetch recent Q&A history for context
    const historyRows = this.getHistory(signalVideoId);
    const history = historyRows.map((r) => ({ question: r.question, answer: r.answer }));

    // Assemble chat prompt with topic filter_text for domain context
    const prompt = assembleChat({
      transcriptionJson: signal.transcriptionJson,
      summary: signal.summary,
      filterText: signal.filterText,
      history,
      question,
    });

    // Buffer for tee pattern
    let bufferedAnswer = '';

    // Stream LLM response
    try {
      for await (const token of callLlmStream(this.llmConfig, prompt)) {
        bufferedAnswer += token;
        yield token;
      }

      // Apply transform to final answer before persisting
      const persistedAnswer = transform ? transform(bufferedAnswer) : bufferedAnswer;
      // is_formatted=1 when transform was applied, 0 for raw text
      this.db.prepare(
        `INSERT INTO signal_chat (signal_video_id, question, answer, is_formatted) VALUES (?, ?, ?, ?)`
      ).run(signalVideoId, question, persistedAnswer, transform ? 1 : 0);
    } catch (error) {
      // Do NOT partial-write to DB on failure
      throw error;
    }
  }

  /**
   * Phase 1: insert a pending chat row with answer=NULL.
   * Returns the inserted row id for later processing.
   *
   * Polymorphic: accepts either a signalVideoId string (per-signal) or a ChatScope object (list-scoped).
   */
  submit(input: string | ChatScope, question?: string): number {
    // Legacy: submit(videoId, question)
    if (typeof input === 'string') {
      const signal = resolveSignalForChat(this.db, input);
      if (!signal) {
        throw new Error(`Signal ${input} not found`);
      }

      const result = this.db.prepare(
        `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)`
      ).run(input, question!);

      return result.lastInsertRowid as number;
    }

    // List-scoped: submit({ topicKey?, channelId?, includeIrrelevant?, question })
    const scope = input;
    const q = scope.question ?? question!;

    // Normalize empty strings to NULL for consistent scope matching.
    // Empty string means "no filter" — store as NULL so getHistory() fallback
    // (topic_key IS NOT NULL OR channel_id IS NOT NULL) works correctly.
    const dbTopicKey = (scope.topicKey === '' || scope.topicKey == null) ? null : scope.topicKey;
    const dbChannelId = (scope.channelId === '' || scope.channelId == null) ? null : scope.channelId;

    // If both are NULL, this is a no-filter list-scoped chat — still mark as list-scoped
    // by setting topic_key to empty string placeholder so getHistory() distinguishes from per-signal
    const finalTopicKey = (dbTopicKey === null && dbChannelId === null) ? '' : dbTopicKey;

    const result = this.db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id, include_irrelevant) VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(
      null,
      q,
      finalTopicKey,
      dbChannelId,
      scope.includeIrrelevant ? 1 : 0
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Phase 2: process a pending chat row — resolve context, call LLM, persist answer.
   * Routes to single-signal or multi-signal prompt based on scope columns.
   * On success: UPDATE SET answer=... 
   * On failure: answer remains NULL, error re-thrown.
   */
  async process(id: number): Promise<void> {
    const row = this.db.prepare(
      'SELECT id, signal_video_id, question, topic_key, channel_id, include_irrelevant FROM signal_chat WHERE id = ?'
    ).get(id) as { 
      id: number; 
      signal_video_id: string | null; 
      question: string; 
      topic_key: string | null; 
      channel_id: string | null; 
      include_irrelevant: number | null 
    } | undefined;

    if (!row) {
      throw new Error(`Chat question ${id} not found`);
    }

    // Determine scope from DB row
    const isListScoped = row.topic_key !== null || row.channel_id !== null;

    if (isListScoped) {
      await this._processMultiSignal(row);
    } else {
      await this._processSingleSignal(row);
    }
  }

  private async _processSingleSignal(row: { id: number; signal_video_id: string | null; question: string }): Promise<void> {
    const videoId = row.signal_video_id!;

    // Resolve signal context
    const signal = resolveSignalForChat(this.db, videoId);
    if (!signal) {
      throw new Error(`Signal ${videoId} not found`);
    }

    // Fetch recent Q&A history for context (exclude this pending row which has no answer yet)
    const historyRows = this.db.prepare(`
      SELECT question, answer FROM signal_chat
      WHERE signal_video_id = ? AND answer IS NOT NULL
      ORDER BY created_at DESC LIMIT 10
    `).all(videoId) as Array<{ question: string; answer: string }>;

    // Assemble chat prompt
    const prompt = assembleChat({
      transcriptionJson: signal.transcriptionJson,
      summary: signal.summary,
      filterText: signal.filterText,
      history: historyRows,
      question: row.question,
    });

    // Call LLM sync — throws on failure, leaving answer=NULL
    const rawAnswer = await callLlmSync(this.llmConfig, prompt);

    // Build signalMap for unified formatter (single-signal passes one entry)
    const sigTitle = this.db.prepare(
      'SELECT title FROM signals WHERE video_id = ?'
    ).get(videoId) as { title: string } | undefined;
    const signalMap: Record<string, { title: string }> = {};
    if (sigTitle) {
      signalMap[videoId] = { title: sigTitle.title };
    }
    const answer = ChatResponseFormatter.format(rawAnswer, signalMap);

    // Persist answer on success (is_formatted=1: TimestampFormatter already ran)
    this.db.prepare(
      'UPDATE signal_chat SET answer = ?, is_formatted = 1 WHERE id = ?'
    ).run(answer, row.id);
  }

  private async _processMultiSignal(row: { id: number; question: string; topic_key: string | null; channel_id: string | null; include_irrelevant: number | null }): Promise<void> {
    // Build scope from DB columns
    const scope: ChatScope = {
      topicKey: row.topic_key ?? undefined,
      channelId: row.channel_id ?? undefined,
      includeIrrelevant: row.include_irrelevant ? true : false,
    };

    // Resolve all signals in scope
    const signals: ChatSignalContext[] = resolveScope(this.db, scope);

    // Fetch recent Q&A history for this scope (exclude this pending row)
    const historyRows = this.getHistory(scope).filter((r) => r.id !== row.id).map((r) => ({ question: r.question, answer: r.answer }));

    // Build signal map for citation formatting
    const signalMap: Record<string, { title: string }> = {};
    for (const s of signals) {
      signalMap[s.videoId] = { title: s.title };
    }

    // Three-tier template resolution: topic override → DB global default → compiled fallback
    let customTemplate: string | undefined;

    // Tier 1: topic-level multi_signal_summary_prompt override
    if (scope.topicKey) {
      const topicRow = this.db.prepare(
        'SELECT multi_signal_summary_prompt FROM topics WHERE key = ?'
      ).get(scope.topicKey) as { multi_signal_summary_prompt: string | null } | undefined;

      if (topicRow?.multi_signal_summary_prompt) {
        customTemplate = topicRow.multi_signal_summary_prompt;
      }
    }

    // Tier 2: DB global default
    if (!customTemplate) {
      customTemplate = getAppSetting(this.db, 'multi_signal_chat_prompt') ?? undefined;
    }
    // Tier 3: compiled fallback (defaultMultiSignalChatPromptTemplate()) — used by assembleMultiSignalChat when customTemplate is undefined

    // Resolve filterText from scope's topic
    let filterText: string | undefined;
    if (scope.topicKey) {
      const topicRow = this.db.prepare(
        'SELECT filter_text FROM topics WHERE key = ?'
      ).get(scope.topicKey) as { filter_text: string | null } | undefined;

      filterText = topicRow?.filter_text || undefined;
    }

    // Assemble multi-signal chat prompt
    const prompt = assembleMultiSignalChat({
      signals,
      history: historyRows,
      question: row.question,
      filterText,
    }, customTemplate);

    // Call LLM sync
    const rawAnswer = await callLlmSync(this.llmConfig, prompt);

    // Transform response with unified formatter
    const answer = ChatResponseFormatter.format(rawAnswer, signalMap);

    // Persist answer on success (is_formatted=1: CitationFormatter ran TimestampFormatter internally)
    this.db.prepare(
      'UPDATE signal_chat SET answer = ?, is_formatted = 1 WHERE id = ?'
    ).run(answer, row.id);
  }

  /**
   * Removes a Q&A pair from the database by id.
   */
  delete(id: number): void {
    this.db.prepare('DELETE FROM signal_chat WHERE id = ?').run(id);
  }
}
