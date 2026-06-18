import Database from 'better-sqlite3';
import { fetchWithRetry } from './http-retry.ts';
import { assemble } from './prompt-assembler.ts';
import { resolveSignalContext } from './signal-context.ts';
import { markSummarized, markIrrelevant } from './signal-state.ts';
import type { LlmPhase } from './phase-registry.ts';

export interface LlmConfig {
  endpoint: string;
  model: string;
}

export interface LlmCallOptions {
  abortSignal?: AbortSignal;
}

export interface LlmStreamOptions extends LlmCallOptions {
  onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void;
}

export interface AnalyzeSignalOptions {
  abortSignal?: AbortSignal;
  onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void;
}

const MAX_RETRIES = 1;
const FETCH_TIMEOUT_MS = 1_500_000; // 25 minutes

/**
 * Sync LLM call — returns the full content string.
 * Uses fetchWithRetry for resilient HTTP with retry + timeout.
 */
export async function callLlmSync(
  config: LlmConfig,
  prompt: string,
  options?: LlmCallOptions
): Promise<string> {
  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { maxRetries: MAX_RETRIES, timeoutMs: FETCH_TIMEOUT_MS, abortSignal: options?.abortSignal });

  if (!response.ok) {
    throw new Error(`LLM sync HTTP ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error('LLM sync returned unexpected response structure');
  }

  return data.choices[0].message.content;
}

/**
 * Streaming LLM call — yields token chunks via Server-Sent Events.
 * Uses fetchWithRetry to obtain the response, then consumes the ReadableStream.
 */
export async function* callLlmStream(
  config: LlmConfig,
  prompt: string,
  options?: LlmCallOptions
): AsyncGenerator<string> {
  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  }, { maxRetries: MAX_RETRIES, timeoutMs: FETCH_TIMEOUT_MS, abortSignal: options?.abortSignal });

  if (!response.ok) {
    throw new Error(`LLM stream HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('LLM stream response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // skip malformed SSE data lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streaming LLM call with phase detection — yields content tokens and fires
 * onPhaseChange callbacks at each phase transition.
 *
 * Phases: intake → reasoning → answering → done
 * - intake: fired at request-send time (tokenCount=0)
 * - reasoning: fired when first chunk has delta.reasoning_content
 * - answering: fired when first chunk has delta.content after reasoning
 * - done: fired when finish_reason === 'stop'
 *
 * Generator yields only content tokens; reasoning_content is not yielded.
 */
export async function* callLlmStreamWithPhases(
  config: LlmConfig,
  prompt: string,
  options?: LlmStreamOptions
): AsyncGenerator<string> {
  const onPhase = options?.onPhaseChange;

  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  }, { maxRetries: MAX_RETRIES, timeoutMs: FETCH_TIMEOUT_MS, abortSignal: options?.abortSignal });

  if (!response.ok) {
    throw new Error(`LLM stream HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('LLM stream response has no body');
  }

  // Fire 'intake' phase at request-send time
  onPhase?.('intake', 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let reasoningFired = false;
  let answeringFired = false;
  let actualTokenCount: number | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason;

          // Capture usage from final chunk (stream_options: include_usage)
          if (parsed.usage?.completion_tokens !== undefined) {
            actualTokenCount = parsed.usage.completion_tokens;
          }

          // Check for done
          if (finishReason === 'stop') {
            // Use actual token count from LLM usage, or fall back to chunk count
            const finalCount = actualTokenCount ?? tokenCount;
            onPhase?.('done', finalCount);
            return;
          }

          // Handle reasoning_content — each chunk is one token
          if (delta?.reasoning_content) {
            tokenCount++;
            if (!reasoningFired) {
              reasoningFired = true;
            }
            onPhase?.('reasoning', tokenCount);
            // Do NOT yield reasoning_content
            continue;
          }

          // Handle content — each chunk is one token
          if (delta?.content) {
            if (!answeringFired) {
              answeringFired = true;
            }
            tokenCount++;
            onPhase?.('answering', tokenCount);
            yield delta.content;
          }
        } catch {
          // skip malformed SSE data lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
const DEFAULT_MODEL = 'qwen/qwen3.6-27b';

export function getLlmConfig(): LlmConfig {
  return {
    endpoint: process.env.LLM_ENDPOINT || DEFAULT_ENDPOINT,
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
  };
}

export interface AnalysisResult {
  success: boolean;
  error?: string;
}

interface MergedAnalysisResponse {
  title?: string;
  summary: string;
  takeaways: Array<{ text: string; timestamp: string }>;
  overall_sentiment: { score: number; label: string };
  entities: Array<{ entity_name: string; entity_type: string; sentiment: string }>;
  compact_text?: string;
  relevant?: boolean;
}


function extractTrailingJson(content: string): string {
  // LLM always outputs [prose reasoning] + [JSON object at end].
  // Scan backwards from the last '}' to find the matching opening '{'.
  const text = content.trimEnd();
  let end = text.length - 1;
  while (end >= 0 && text[end] !== '}') end--;
  if (end < 0) return content;

  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') depth--;
    if (depth === 0) return text.substring(i, end + 1);
  }
  return content;
}

function clampScore(score: number): number {
  return Math.max(1, Math.min(5, Math.round(score)));
}

/** @internal — streams via callLlmStreamWithPhases, buffers tokens, returns full content string */
async function callLlmStreamBuffered(
  endpoint: string,
  model: string,
  prompt: string,
  callName: string,
  videoId: string,
  options?: AnalyzeSignalOptions
): Promise<string> {
  try {
    let buffer = '';
    for await (const token of callLlmStreamWithPhases({ endpoint, model }, prompt, {
      abortSignal: options?.abortSignal,
      onPhaseChange: options?.onPhaseChange,
    })) {
      buffer += token;
    }
    return buffer;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.name === 'AbortError') {
      throw new Error(`LLM ${callName} timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${videoId}`);
    }
    throw new Error(`LLM ${callName} failed for ${videoId}: ${err.message}`);
  }
}

export async function analyzeSignal(
  db: Database.Database,
  videoId: string,
  config: LlmConfig,
  signal?: AbortSignal,
  onPhaseChange?: (phase: LlmPhase, tokenCount: number) => void
): Promise<AnalysisResult> {
  try {
    // Resolve signal context using single joined query (issue #100)
    let context;
    try {
      context = resolveSignalContext(videoId, db);
    } catch (e: any) {
      return { success: false, error: e.message || `Signal ${videoId} not found` };
    }

    // Assemble prompt using PromptAssembler (issue #100)
    const prompt = assemble(context);

    const analysisContent = await callLlmStreamBuffered(
      config.endpoint, config.model, prompt, 'analysis', videoId, { abortSignal: signal, onPhaseChange }
    );

    // LLM always outputs [prose reasoning] + [JSON object at end].
    // Extract the final JSON by scanning backwards from the closing brace.
    const jsonStr = extractTrailingJson(analysisContent);
    const analysis: MergedAnalysisResponse = JSON.parse(jsonStr);
    const isRelevant = analysis.relevant !== false;

    if (!isRelevant) {
      // Set processing_state to irrelevant — keep the summarize button visible.
      markIrrelevant(db, videoId);
      return { success: true };
    }

    const summaryDisplay = [analysis.summary, ...analysis.takeaways.map((t) => `${t.timestamp} ${t.text}`)].join('\n');
    const clampedScore = clampScore(analysis.overall_sentiment.score);
    const entities = analysis.entities;
    const generatedTitle = analysis.title ? analysis.title.substring(0, 100) : null;

    const compactText = analysis.compact_text ?? null;
    db.prepare(`
      UPDATE signals SET summary = ?, overall_sentiment = ?, sentiment_label = ?, generated_title = ?, compact_text = ?
      WHERE video_id = ?
    `).run(summaryDisplay, clampedScore, analysis.overall_sentiment.label, generatedTitle, compactText, videoId);

    markSummarized(db, videoId);

    db.prepare('DELETE FROM entity_mentions WHERE signal_video_id = ?').run(videoId);

    const insertEntity = db.prepare(`
      INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment) VALUES (?, ?, ?, ?)
    `);
    for (const entity of entities) {
      insertEntity.run(videoId, entity.entity_name, entity.entity_type, entity.sentiment);
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown LLM error';
    console.error(`LLM analysis failed for ${videoId}: ${message}`);
    return { success: false, error: message };
  }
}