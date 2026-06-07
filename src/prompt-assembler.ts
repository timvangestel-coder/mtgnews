import type { SignalContext } from './signal-context';

export interface ChatContext {
  transcriptionJson: string;
  summary: string;
  filterText?: string;
  history: Array<{ question: string; answer: string }>;
  question: string;
}

/**
 * Formats raw transcription JSON into timestamped text.
 * e.g. `[T:45] hello world [T:92] mtg news`
 */
export function formatTranscription(transcriptionJson: string): string {
  try {
    const segments = JSON.parse(transcriptionJson);
    if (Array.isArray(segments)) {
      if (segments[0]?.time !== undefined) {
        return segments.map((s: any) => `[T:${Math.floor(s.time / 1000)}] ${s.text}`).join(' ');
      }
      return segments.map((s: any) => `[T:${Math.floor(s.start / 1000)}] ${s.text}`).join(' ');
    }
  } catch {
    // plain text transcription
  }
  return transcriptionJson;
}

/**
 * Default prompt template with XML placeholder tags.
 * Extracted from the original hardcoded prompt in prompt-builder.ts.
 */
export function defaultPromptTemplate(): string {
  return `You are a content analyst. Analyze the following video transcription and produce a structured JSON response containing summary, key takeaways, overall sentiment, and entity mentions.

<filter_text>{FILTER_TEXT}</filter_text>

First, judge whether the content meets the channel's filter criteria. Include "relevant": true or "relevant": false in your JSON response. If content does not meet the criteria, set relevant to false.

IMPORTANT: If content is NOT relevant, return ONLY {"relevant": false} without generating summary, takeaways, sentiment, or entities.

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
  ],
  "relevant": true
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

<transcription>{TRANSCRIPTION}</transcription>`;
}

/**
 * Assembles an LLM prompt from a SignalContext.
 * Pure function: SignalContext → string. No DB access, no side effects.
 */
export function assemble(context: SignalContext): string {
  const template = context.summaryPrompt ?? defaultPromptTemplate();
  const transcriptionText = formatTranscription(context.transcriptionJson);

  return template
    .replace(/{TRANSCRIPTION}/g, transcriptionText)
    .replace(/{FILTER_TEXT}/g, context.filterText);
}

/**
 * Default chat prompt template with XML placeholder tags.
 * Uses generic analyst role — domain scoping via filter_text if provided.
 */
export function defaultChatPromptTemplate(): string {
  return `You are a content analyst. Answer the user's question based on the video transcription and summary provided.

<filter_text>{FILTER_TEXT}</filter_text>

Use timestamps in "T:ss" format (ss = seconds as integer) when referencing specific parts of the video.

<transcription>{TRANSCRIPTION}</transcription>

<summary>{SUMMARY}</summary>

{HISTORY}

<question>{QUESTION}</question>`;
}

/**
 * Formats history exchanges into nested XML blocks.
 */
function formatHistory(history: Array<{ question: string; answer: string }>): string {
  if (history.length === 0) return '';

  const exchanges = history.map((h) => {
    return `  <exchange>
    <question>${h.question}</question>
    <answer>${h.answer}</answer>
  </exchange>`;
  }).join('\n');

  return `<history>\n${exchanges}\n</history>`;
}

/**
 * Assembles a chat prompt from a ChatContext.
 * Pure function: ChatContext → string. No DB access, no side effects.
 * Three-tier template resolution: customTemplate → defaultChatPromptTemplate()
 */
export function assembleChat(context: ChatContext, customTemplate?: string): string {
  const template = customTemplate ?? defaultChatPromptTemplate();
  const transcriptionText = formatTranscription(context.transcriptionJson);
  const historyText = formatHistory(context.history);

  return template
    .replace(/{FILTER_TEXT}/g, context.filterText || '')
    .replace(/{TRANSCRIPTION}/g, transcriptionText)
    .replace(/{SUMMARY}/g, context.summary)
    .replace(/{HISTORY}/g, historyText)
    .replace(/{QUESTION}/g, context.question);
}
