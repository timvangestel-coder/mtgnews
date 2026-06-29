// NOTE: All queries reading channels/signals/entity_mentions/signal_chat/poll_run_progress must filter
// deleted rows using softDeleteFilter(alias). See ADR-0015 (issue #185).
import Database from 'better-sqlite3';
import { LlmConfig, callLlmStream, callLlmSync, callLlmStreamWithTools, FunctionTool } from '../llm';
import type { LlmPhase } from '../phase-registry.ts';
import { assembleChat, type FormatStyle, type SignalIndexEntry } from '../prompt-assembler';
import { ChatScope, resolveIndexScope, DateFilterOptions } from '../signal-chat-scope';
import { ChatResponseFormatter } from '../chat-response-formatter';
import { createAgentConversation } from '../chat-conversation-state';
import { getAppSetting } from '../db/app-settings';
import { softDeleteFilter } from '../db/soft-delete-filter';

/** Maximum number of agent loop rounds before forcing final answer */
const MAX_AGENT_ROUNDS = 3;

/** Fallback message when the agent loop reaches max rounds without a final answer */
const EMPTY_ANSWER_FALLBACK = '[The system reached the maximum number of retrieval rounds without a final answer.]';

/** Tool definition for get_compact_text */
const GET_COMPACT_TEXT_TOOL: FunctionTool = {
  type: 'function',
  function: {
    name: 'get_compact_text',
    description: 'Retrieve compact transcription text for specific videos by their video IDs',
    parameters: {
      type: 'object',
      properties: {
        videoIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of video IDs to retrieve compact text for',
        },
      },
      required: ['videoIds'],
    },
  },
};

/**
 * Executes the get_compact_text tool by querying SQLite for compact_text rows.
 * Returns a formatted string suitable as a tool response message.
 */
function executeGetCompactText(db: Database.Database, videoIds: string[]): string {
  const results: Array<{ videoId: string; title: string; content: string }> = [];

  for (const vid of videoIds) {
    const row = db.prepare(
      `SELECT video_id, title, compact_text FROM signals s WHERE 1=1 ${softDeleteFilter('s')} AND s.video_id = ?`
    ).get(vid) as { video_id: string; title: string; compact_text: string | null } | undefined;

    if (row && row.compact_text) {
      results.push({
        videoId: row.video_id,
        title: row.title,
        content: row.compact_text,
      });
    }
  }

  return JSON.stringify(results);
}

/**
 * Resolves the chat response format style from AppSettings.
 * Defaults to 'annotated-index' when key is not set or value is invalid.
 */
function resolveFormatStyle(db: Database.Database): FormatStyle {
  const setting = getAppSetting(db, 'chat_response_format');
  if (setting === 'plain' || setting === 'annotated-index') {
    return setting;
  }
  return 'annotated-index';
}

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
function resolveSignalForChat(db: Database.Database, videoId: string): { transcriptionJson: string; summary: string; compactText?: string; filterText?: string } | null {
  const row = db.prepare(`
    SELECT s.transcription, s.summary, s.compact_text, t.filter_text
    FROM signals s
    LEFT JOIN channels c ON s.channel_id = c.channel_id
    LEFT JOIN topics t ON c.topic_id = t.id
    WHERE 1=1 ${softDeleteFilter('s')} ${softDeleteFilter('c')} AND s.video_id = ?
  `).get(videoId) as { transcription: string; summary: string | null; compact_text: string | null; filter_text?: string } | undefined;

  if (!row) return null;
  return {
    transcriptionJson: row.transcription,
    summary: row.summary ?? '',
    compactText: row.compact_text || undefined,
    filterText: row.filter_text || undefined,
  };
}

export interface ProcessOptions {
  abortSignal?: AbortSignal;
  onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void;
  /** Called for each token emitted during agent loop rounds. Enables streaming retrieval thoughts and final answer to external consumers (UI via SSE/HTMX). */
  onToken?: (token: string) => void;
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
        FROM signal_chat sc
        WHERE 1=1 ${softDeleteFilter('sc')} AND sc.signal_video_id = ?
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

    // Issue #181: date_filter as part of strict composite scope
    const effectiveDateFilter = (filter.dateFilter === '' || filter.dateFilter === 'all') ? undefined : filter.dateFilter;
    if (effectiveDateFilter !== undefined) {
      conditions.push('date_filter = ?');
      params.push(effectiveDateFilter);
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

    const andClause2 = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT id, signal_video_id, question, answer, COALESCE(is_formatted, 0) AS is_formatted, created_at
      FROM signal_chat sc
      WHERE 1=1 ${softDeleteFilter('sc')} ${andClause2}
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
    const history = historyRows.map((r) => ({ question: r.question, answer: r.answer ?? '' }));

    // Assemble chat prompt with format style from AppSettings (defaults to 'annotated-index')
    const formatStyle = resolveFormatStyle(this.db);
    const prompt = assembleChat({
      transcriptionJson: signal.transcriptionJson,
      summary: signal.summary,
      compactText: signal.compactText,
      filterText: signal.filterText,
      history,
      question,
    }, undefined, formatStyle);

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

    // List-scoped: submit({ topicKey?, channelId?, includeIrrelevant?, dateFilter?, question })
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

    // Issue #181: store date_filter for date-scoped chat history
    const dbDateFilter = scope.dateFilter && scope.dateFilter !== 'all' ? scope.dateFilter : 'all';

    const result = this.db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer, topic_key, channel_id, include_irrelevant, date_filter) VALUES (?, ?, NULL, ?, ?, ?, ?)`
    ).run(
      null,
      q,
      finalTopicKey,
      dbChannelId,
      scope.includeIrrelevant ? 1 : 0,
      dbDateFilter
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Phase 2: process a pending chat row — resolve context, call LLM, persist answer.
   * Routes to single-signal or multi-signal prompt based on scope columns.
   * On success: UPDATE SET answer=... 
   * On failure: answer remains NULL, error re-thrown.
   *
   * @param options - optional processing options including abortSignal for cancellation
   */
  async process(id: number, options?: ProcessOptions): Promise<void> {
    const row = this.db.prepare(
      'SELECT id, signal_video_id, question, topic_key, channel_id, include_irrelevant, date_filter FROM signal_chat WHERE id = ?'
    ).get(id) as { 
      id: number; 
      signal_video_id: string | null; 
      question: string; 
      topic_key: string | null; 
      channel_id: string | null; 
      include_irrelevant: number | null;
      date_filter: string | null;
    } | undefined;

    if (!row) {
      throw new Error(`Chat question ${id} not found`);
    }

    // Determine scope from DB row
    const isListScoped = row.topic_key !== null || row.channel_id !== null;

    if (isListScoped) {
      await this._processMultiSignal(row, options?.abortSignal, options?.onPhaseChange, options?.onToken);
    } else {
      await this._processSingleSignal(row, options?.abortSignal, options?.onPhaseChange, options?.onToken);
    }
  }

  /**
   * Thin adapter: resolves index via resolveIndexScope({ videoId }) and delegates to _runAgentLoop.
   */
  private async _processSingleSignal(row: { id: number; signal_video_id: string | null; question: string }, abortSignal?: AbortSignal, onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void, onToken?: (token: string) => void): Promise<void> {
    const videoId = row.signal_video_id!;

    // Resolve index via resolveIndexScope (uniform with multi-signal path)
    const indexEntries = resolveIndexScope(this.db, { videoId });

    // Fetch recent Q&A history for this signal (exclude this pending row)
    const historyRows = this.db.prepare(`
      SELECT question, answer FROM signal_chat sc
      WHERE 1=1 ${softDeleteFilter('sc')} AND sc.signal_video_id = ? AND sc.answer IS NOT NULL
      ORDER BY created_at DESC LIMIT 10
    `).all(videoId) as Array<{ question: string; answer: string }>;

    // Build signalMap for citation formatting
    const signalMap: Record<string, { title: string }> = {};
    for (const e of indexEntries) {
      signalMap[e.videoId] = { title: e.title };
    }

    await this._runAgentLoop(indexEntries, signalMap, row.question, row.id, historyRows, abortSignal, onPhaseChange, onToken);
  }

  /**
   * Thin adapter: resolves index via resolveIndexScope(scope) and delegates to _runAgentLoop.
   */
  private async _processMultiSignal(row: { id: number; question: string; topic_key: string | null; channel_id: string | null; include_irrelevant: number | null; date_filter: string | null }, abortSignal?: AbortSignal, onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void, onToken?: (token: string) => void): Promise<void> {
    // Build scope from DB columns
    const scope: ChatScope = {
      topicKey: row.topic_key ?? undefined,
      channelId: row.channel_id ?? undefined,
      includeIrrelevant: row.include_irrelevant ? true : false,
      dateFilter: row.date_filter && row.date_filter !== 'all' ? row.date_filter : undefined,
    };

    // Issue #181: compute date range for signal index resolution
    const dateOptions: DateFilterOptions = {};
    if (scope.dateFilter) {
      // Import computeDateRange dynamically to avoid circular deps
      const { computeDateRange } = await import('../scope-source');
      const range = computeDateRange(scope.dateFilter);
      if (range.from) {
        dateOptions.dateFrom = range.from;
      }
    }

    // Resolve index via resolveIndexScope with date filtering
    const indexEntries = resolveIndexScope(this.db, scope, dateOptions);

    // Fetch recent Q&A history for this scope (exclude this pending row)
    const historyRows = this.getHistory(scope).filter((r) => r.id !== row.id).map((r) => ({ question: r.question, answer: r.answer ?? '' }));

    // Build signalMap for citation formatting from index entries
    const signalMap: Record<string, { title: string }> = {};
    for (const e of indexEntries) {
      signalMap[e.videoId] = { title: e.title };
    }

    await this._runAgentLoop(indexEntries, signalMap, row.question, row.id, historyRows, abortSignal, onPhaseChange, onToken);
  }

  /**
   * Shared agent loop: runs up to MAX_AGENT_ROUNDS rounds of LLM + tool calling.
   * After the loop, applies empty-answer guard and persists via ChatResponseFormatter.
   * 
   * Both single-signal and multi-signal paths delegate here.
   */
  private async _runAgentLoop(
    indexEntries: SignalIndexEntry[],
    signalMap: Record<string, { title: string }>,
    question: string,
    rowId: number,
    historyRows: Array<{ question: string; answer: string }>,
    abortSignal?: AbortSignal,
    onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void,
    onToken?: (token: string) => void
  ): Promise<void> {
    // Round-aware conversation: signal index emitted only on Round 1, dropped on Round 2+
    const conversation = createAgentConversation(indexEntries, question, historyRows);

    let bufferedAnswer = '';

    try {
      // Agent loop with get_compact_text tool, hard cap at MAX_AGENT_ROUNDS rounds
      for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
        // Check abort between rounds
        if (abortSignal?.aborted) {
          return;
        }

        onPhaseChange?.(round === 0 ? 'intake' : 'retrieving', round);

        // Call LLM with tool definition — buildNextPrompt() drops signal index after Round 1
        // Pass onPhaseChange so reasoning phase + token counts reach the UI (issues #174, #175)
        const result = await callLlmStreamWithTools(this.llmConfig, conversation.buildNextPrompt(), [GET_COMPACT_TEXT_TOOL], { abortSignal, onPhaseChange });

        // Consume tokens, stream to onToken, and accumulate answer content
        // Track answerTokenCount per token and fire onPhaseChange every 5 tokens (issue #174)
        let roundContent = '';
        let answerTokenCount = 0;
        for await (const token of result.tokens) {
          onToken?.(token);
          roundContent += token;
          answerTokenCount++;
          if (answerTokenCount % 5 === 0) {
            onPhaseChange?.('answering', answerTokenCount);
          }
        }
        // Fire final count when stream completes (issue #174)
        if (answerTokenCount > 0 && answerTokenCount % 5 !== 0) {
          onPhaseChange?.('answering', answerTokenCount);
        }

        if (result.toolCalls.length === 0) {
          // No tool calls: this is the final answer - only this content persisted
          bufferedAnswer += roundContent;
          break;
        }

        // Handle tool calls — execute get_compact_text for each
        for (const toolCall of result.toolCalls) {
          if (toolCall.function.name === 'get_compact_text') {
            const args = JSON.parse(toolCall.function.arguments);
            const videoIds = args.videoIds as string[];

            // Execute SQLite query for compact_text
            const toolResult = executeGetCompactText(this.db, videoIds);

            // Record tool call + result in conversation (signal index dropped after Round 1)
            conversation.addToolCall(toolCall, toolResult);
          }
        }
      }

      // Check abort before persisting
      if (abortSignal?.aborted) {
        return;
      }

      // Empty answer guard: if LLM returned only tool calls without a final answer
      if (!bufferedAnswer.trim()) {
        bufferedAnswer = EMPTY_ANSWER_FALLBACK;
      }

      onPhaseChange?.('answering', 0);

      const answer = ChatResponseFormatter.format(bufferedAnswer, signalMap);

      // Persist answer to DB
      this.db.prepare(
        'UPDATE signal_chat SET answer = ?, is_formatted = 1 WHERE id = ?'
      ).run(answer, rowId);
    } catch (error) {
      // Do NOT partial-write to DB on failure — answer remains NULL
      throw error;
    }
  }

  /**
   * Removes a Q&A pair from the database by id.
   */
  delete(id: number): void {
    this.db.prepare('DELETE FROM signal_chat WHERE id = ?').run(id);
  }
}