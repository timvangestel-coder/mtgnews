import Database from 'better-sqlite3';
import { fetchWithRetry } from './http-retry';
import { buildMergedPrompt } from './prompt-builder';

export interface LlmConfig {
  endpoint: string;
  model: string;
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
  summary: string;
  takeaways: Array<{ text: string; timestamp: string }>;
  overall_sentiment: { score: number; label: string };
  entities: Array<{ entity_name: string; entity_type: string; sentiment: string }>;
  relevant?: boolean;
}

function extractTranscriptionText(transcription: string): string {
  try {
    const segments = JSON.parse(transcription);
    if (Array.isArray(segments)) {
      if (segments[0]?.time !== undefined) {
        return segments.map((s: any) => `[T:${Math.floor(s.time / 1000)}] ${s.text}`).join(' ');
      }
      return segments.map((s: any) => `[T:${Math.floor(s.start / 1000)}] ${s.text}`).join(' ');
    }
  } catch {
    // plain text transcription
  }
  return transcription;
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

const MAX_RETRIES = 1;
const FETCH_TIMEOUT_MS = 300_000; // 5 minutes

async function callLlmWithRetry(
  endpoint: string,
  model: string,
  prompt: string,
  callName: string,
  videoId: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    }, { maxRetries: MAX_RETRIES, timeoutMs: FETCH_TIMEOUT_MS, abortSignal: signal });

    if (!response.ok) {
      throw new Error(`LLM ${callName} HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
      throw new Error(`LLM ${callName} returned unexpected response structure`);
    }

    return data.choices[0].message.content;
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
  signal?: AbortSignal
): Promise<AnalysisResult> {
  try {
    const sigRow = db.prepare('SELECT transcription FROM signals WHERE video_id = ?').get(videoId);
    if (!sigRow) {
      return { success: false, error: `Signal ${videoId} not found` };
    }

    const transcriptionText = extractTranscriptionText((sigRow as any).transcription as string);

    // Fetch channel topic filter_text (issue #52)
    const sigFull = db.prepare('SELECT channel_id FROM signals WHERE video_id = ?').get(videoId) as { channel_id: string } | undefined;
    let filterText: string | undefined;
    if (sigFull?.channel_id) {
      const chRow = db.prepare('SELECT topic_id FROM channels WHERE channel_id = ?').get(sigFull.channel_id) as { topic_id?: number | null } | undefined;
      if (chRow?.topic_id) {
        const topicRow = db.prepare('SELECT filter_text FROM topics WHERE id = ?').get(chRow.topic_id) as { filter_text?: string } | undefined;
        filterText = topicRow?.filter_text || undefined;
      }
    }

    const analysisContent = await callLlmWithRetry(
      config.endpoint, config.model, buildMergedPrompt(transcriptionText, filterText), 'analysis', videoId, signal
    );

    // LLM always outputs [prose reasoning] + [JSON object at end].
    // Extract the final JSON by scanning backwards from the closing brace.
    const jsonStr = extractTrailingJson(analysisContent);
    const analysis: MergedAnalysisResponse = JSON.parse(jsonStr);
    const isRelevant = analysis.relevant !== false;

    if (!isRelevant) {
      // Don't set processed_at for irrelevant signals — keep the summarize button visible.
      db.prepare('UPDATE signals SET relevance_status = ? WHERE video_id = ?')
        .run('irrelevant', videoId);
      return { success: true };
    }

    const summaryDisplay = [analysis.summary, ...analysis.takeaways.map((t) => `${t.timestamp} ${t.text}`)].join('\n');
    const clampedScore = clampScore(analysis.overall_sentiment.score);
    const entities = analysis.entities;

    db.prepare(`
      UPDATE signals SET summary = ?, overall_sentiment = ?, sentiment_label = ?, processed_at = ?, relevance_status = ?
      WHERE video_id = ?
    `).run(summaryDisplay, clampedScore, analysis.overall_sentiment.label, Date.now(), 'relevant', videoId);

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