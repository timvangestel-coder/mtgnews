import Database from 'better-sqlite3';

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

function buildMergedPrompt(transcriptionText: string, filterText?: string): string {
  const relevanceSection = filterText
    ? `Channel filter text: ${filterText}

First, judge whether the content meets the channel's filter criteria. Include "relevant": true or "relevant": false in your JSON response. If content does not meet the criteria, set relevant to false.`
    : '';

  const minimalInstruction = filterText
    ? `\n\nIMPORTANT: If content is NOT relevant, return ONLY {"relevant": false} without generating summary, takeaways, sentiment, or entities.`
    : '';

  return `You are a content analyst. Analyze the following video transcription and produce a structured JSON response containing summary, key takeaways, overall sentiment, and entity mentions.${relevanceSection ? '\n\n' + relevanceSection : ''}${minimalInstruction}

Return ONLY valid JSON with this structure:
{
  "summary": "A concise 2-3 sentence summary of the relevant content",
  "takeaways": [
    { "text": "Key takeaway description", "timestamp": "T:ss" }
  ],
  "overall_sentiment": {
    "score": 3,
    "label": "Neutral"
  },
  "entities": [
    { "entity_name": "ExampleEntity", "entity_type": "other", "sentiment": "Positive" }
  ]${relevanceSection ? ',\n  "relevant": true' : ''}
}

Rules:
- Each takeaway must include a timestamp in "T:ss" format where ss is the start seconds as an integer
- Focus only on topics matching the channel filter text
- Keep takeaways concise and actionable

Sentiment score scale (integer 1-5):
1 = Very Negative
2 = Negative
3 = Neutral
4 = Positive
5 = Very Positive

Entity types: card, set, player, format, archetype, company, event, rules, other
Sentiment labels for entities: Positive, Negative, Neutral

Transcription:
${transcriptionText}`;
}

function extractTranscriptionText(transcription: string): string {
  try {
    const segments = JSON.parse(transcription);
    if (Array.isArray(segments)) {
      // New grouped shape: [{time: number (ms), text: string}]
      if (segments[0]?.time !== undefined) {
        return segments.map((s: any) => `[T:${Math.floor(s.time / 1000)}] ${s.text}`).join(' ');
      }
      // Legacy raw segment shape: [{start: number, text: string}]
      return segments.map((s: any) => `[T:${Math.floor(s.start / 1000)}] ${s.text}`).join(' ');
    }
  } catch {
    // plain text transcription
  }
  return transcription;
}

function clampScore(score: number): number {
  return Math.max(1, Math.min(5, Math.round(score)));
}

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 300_000; // 5 minutes

async function callLlmWithRetry(
  endpoint: string,
  model: string,
  prompt: string,
  callName: string,
  videoId: string,
  signal?: AbortSignal
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      // Merge external abort signal with internal timeout
      const internal = new AbortController();
      const timeoutId = setTimeout(() => internal.abort(), FETCH_TIMEOUT_MS);

      // Abort if either external or internal triggers
      let mySignal = internal.signal;
      if (signal) {
        const combined = new AbortController();
        const onExternal = () => combined.abort(new Error('Poll run aborted by user'));
        signal.addEventListener('abort', onExternal, { once: true });
        if (signal.aborted) { combined.abort(signal.reason); }
        mySignal = combined.signal;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: mySignal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`LLM ${callName} HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.choices?.[0]?.message?.content) {
        throw new Error(`LLM ${callName} returned unexpected response structure`);
      }

      return data.choices[0].message.content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If aborted (timeout), do not retry
      if (lastError.name === 'AbortError') {
        throw new Error(`LLM ${callName} timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${videoId}`);
      }

      // Only retry on transient network errors
      const isTransient =
        lastError.name === 'TypeError' ||
        lastError.message.includes('fetch failed') ||
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ECONNREFUSED');

      if (!isTransient || attempt >= MAX_RETRIES) {
        break;
      }

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(
        `LLM ${callName} attempt ${attempt} failed for ${videoId}, retrying in ${delay}ms: ${lastError.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`LLM ${callName} failed after ${MAX_RETRIES + 1} attempt(s) for ${videoId}: ${lastError?.message}`);
}

export async function analyzeSignal(
  db: Database.Database,
  videoId: string,
  config: LlmConfig,
  signal?: AbortSignal
): Promise<AnalysisResult> {
  try {
    // Fetch signal row from db
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

    // Single merged LLM call (issue #38)
    const analysisContent = await callLlmWithRetry(config.endpoint, config.model, buildMergedPrompt(transcriptionText, filterText), 'analysis', videoId, signal);
    const analysis: MergedAnalysisResponse = JSON.parse(analysisContent);

    // Handle relevance (issue #45): missing relevant = treat as true (backward compat)
    const isRelevant = analysis.relevant !== false;

    if (!isRelevant) {
      // Irrelevant: set status + processed_at, skip summary/sentiment/entities
      db.prepare('UPDATE signals SET relevance_status = ?, processed_at = ? WHERE video_id = ?').run('irrelevant', Date.now(), videoId);
      return { success: true };
    }

    const summaryDisplay = [analysis.summary, ...analysis.takeaways.map((t) => `${t.timestamp} ${t.text}`)].join('\n');

    const clampedScore = clampScore(analysis.overall_sentiment.score);
    const entities = analysis.entities;

    // Persist results
    const updateSignal = db.prepare(`
      UPDATE signals SET summary = ?, overall_sentiment = ?, sentiment_label = ?, processed_at = ?, relevance_status = ?
      WHERE video_id = ?
    `);
    updateSignal.run(summaryDisplay, clampedScore, analysis.overall_sentiment.label, Date.now(), 'relevant', videoId);

    // Delete old entity mentions, insert new
    db.prepare('DELETE FROM entity_mentions WHERE signal_video_id = ?').run(videoId);

    const insertEntity = db.prepare(`
      INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment)
      VALUES (?, ?, ?, ?)
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