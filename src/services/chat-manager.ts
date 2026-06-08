import Database from 'better-sqlite3';
import { LlmConfig, callLlmStream, callLlmSync } from '../llm';
import { assembleChat } from '../prompt-assembler';

export interface ChatMessage {
  id: number;
  signal_video_id: string;
  question: string;
  answer: string | null;
  created_at: string;
}

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
   * Returns recent Q&A pairs for a signal, ordered by created_at DESC.
   * Default limit is 10.
   */
  getHistory(signalVideoId: string, limit: number = 10): ChatMessage[] {
    return this.db.prepare(`
      SELECT id, signal_video_id, question, answer, created_at
      FROM signal_chat
      WHERE signal_video_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(signalVideoId, limit) as ChatMessage[];
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
      this.db.prepare(
        `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)`
      ).run(signalVideoId, question, persistedAnswer);
    } catch (error) {
      // Do NOT partial-write to DB on failure
      throw error;
    }
  }

  /**
   * Phase 1: insert a pending chat row with answer=NULL.
   * Returns the inserted row id for later processing.
   * Throws if the signal is not found.
   */
  submit(signalVideoId: string, question: string): number {
    const signal = resolveSignalForChat(this.db, signalVideoId);
    if (!signal) {
      throw new Error(`Signal ${signalVideoId} not found`);
    }

    const result = this.db.prepare(
      `INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, NULL)`
    ).run(signalVideoId, question);

    return result.lastInsertRowid as number;
  }

  /**
   * Phase 2: process a pending chat row — resolve context, call LLM, persist answer.
   * On success: UPDATE SET answer=... 
   * On failure: answer remains NULL, error re-thrown.
   */
  async process(id: number): Promise<void> {
    const row = this.db.prepare(
      'SELECT id, signal_video_id, question FROM signal_chat WHERE id = ?'
    ).get(id) as { id: number; signal_video_id: string; question: string } | undefined;

    if (!row) {
      throw new Error(`Chat question ${id} not found`);
    }

    // Resolve signal context
    const signal = resolveSignalForChat(this.db, row.signal_video_id);
    if (!signal) {
      throw new Error(`Signal ${row.signal_video_id} not found`);
    }

    // Fetch recent Q&A history for context (exclude this pending row which has no answer yet)
    const historyRows = this.db.prepare(`
      SELECT question, answer FROM signal_chat
      WHERE signal_video_id = ? AND answer IS NOT NULL
      ORDER BY created_at DESC LIMIT 10
    `).all(row.signal_video_id) as Array<{ question: string; answer: string }>;

    // Assemble chat prompt
    const prompt = assembleChat({
      transcriptionJson: signal.transcriptionJson,
      summary: signal.summary,
      filterText: signal.filterText,
      history: historyRows,
      question: row.question,
    });

    // Call LLM sync — throws on failure, leaving answer=NULL
    const answer = await callLlmSync(this.llmConfig, prompt);

    // Persist answer on success
    this.db.prepare(
      'UPDATE signal_chat SET answer = ? WHERE id = ?'
    ).run(answer, row.id);
  }

  /**
   * Removes a Q&A pair from the database by id.
   */
  delete(id: number): void {
    this.db.prepare('DELETE FROM signal_chat WHERE id = ?').run(id);
  }
}
