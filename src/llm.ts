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

interface SummaryResponse {
  summary: string;
  takeaways: Array<{ text: string; timestamp: string }>;
}

interface SentimentResponse {
  score: number;
  label: string;
}

interface EntityResponse {
  entity_name: string;
  entity_type: string;
  sentiment: string;
}

function buildSummaryPrompt(transcriptionText: string): string {
  return `You are an MTG (Magic: The Gathering) content analyst. Analyze the following video transcription and produce a structured JSON response.

Return ONLY valid JSON with this structure:
{
  "summary": "A concise 2-3 sentence summary of the MTG-relevant content",
  "takeaways": [
    { "text": "Key takeaway description", "timestamp": "T:ss" }
  ]
}

Rules:
- Each takeaway must include a [T:ss] timestamp reference where ss is the start seconds as an integer
- Focus only on MTG-relevant topics (cards, sets, formats, players, meta, rules)
- Keep takeaways concise and actionable

Transcription:
${transcriptionText}`;
}

function buildSentimentPrompt(transcriptionText: string): string {
  return `You are an MTG (Magic: The Gathering) sentiment analyst. Analyze the overall sentiment of the following video transcription.

Return ONLY valid JSON with this structure:
{
  "score": 3,
  "label": "Neutral"
}

Score scale (integer 1-5):
1 = Very Negative
2 = Negative
3 = Neutral
4 = Positive
5 = Very Positive

Transcription:
${transcriptionText}`;
}

function buildEntityPrompt(transcriptionText: string): string {
  return `You are an MTG (Magic: The Gathering) entity sentiment analyst. Extract all MTG-relevant entities mentioned in the transcription and assign a sentiment label to each.

Return ONLY valid JSON as an array:
[
  { "entity_name": "Kaldra", "entity_type": "set", "sentiment": "Positive" },
  { "entity_name": "Dredge", "entity_type": "archetype", "sentiment": "Negative" }
]

Entity types: card, set, player, format, archetype, company, event, rules, other
Sentiment labels: Positive, Negative, Neutral

Transcription:
${transcriptionText}`;
}

function extractTranscriptionText(transcription: string): string {
  try {
    const segments = JSON.parse(transcription);
    if (Array.isArray(segments)) {
      return segments.map((s: any) => `[T:${Math.floor(s.start)}] ${s.text}`).join(' ');
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
  videoId: string
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
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
  config: LlmConfig
): Promise<AnalysisResult> {
  try {
    // Fetch signal from db
    const signal = db.prepare('SELECT transcription FROM signals WHERE video_id = ?').get(videoId);
    if (!signal) {
      return { success: false, error: `Signal ${videoId} not found` };
    }

    const transcriptionText = extractTranscriptionText(signal.transcription as string);

    // 1. Summary
    const summaryContent = await callLlmWithRetry(config.endpoint, config.model, buildSummaryPrompt(transcriptionText), 'summary', videoId);
    const summary: SummaryResponse = JSON.parse(summaryContent);

    const summaryDisplay = [summary.summary, ...summary.takeaways.map((t: any) => `${t.timestamp} ${t.text}`)].join('\n');

    // 2. Overall Sentiment
    const sentimentContent = await callLlmWithRetry(config.endpoint, config.model, buildSentimentPrompt(transcriptionText), 'sentiment', videoId);
    const sentiment: SentimentResponse = JSON.parse(sentimentContent);

    const clampedScore = clampScore(sentiment.score);

    // 3. Per-Entity Sentiment
    const entitiesContent = await callLlmWithRetry(config.endpoint, config.model, buildEntityPrompt(transcriptionText), 'entities', videoId);
    const entities: EntityResponse[] = JSON.parse(entitiesContent);

    // Persist results
    const updateSignal = db.prepare(`
      UPDATE signals SET summary = ?, overall_sentiment = ?, sentiment_label = ?, processed_at = ?
      WHERE video_id = ?
    `);
    updateSignal.run(summaryDisplay, clampedScore, sentiment.label, Date.now(), videoId);

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