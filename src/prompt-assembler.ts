import type { SignalContext } from './signal-context.ts';
import type { ChatSignalContext } from './signal-chat-scope.ts';

export type FormatStyle = 'plain' | 'annotated-index';

/**
 * Lightweight signal entry for AgentChat index.
 * Contains only metadata needed for the LLM to decide which signals to retrieve via tool calls.
 * ~50 tokens per entry when serialized to XML. Excludes compact_text and transcription.
 */
export interface SignalIndexEntry {
  videoId: string;
  title: string;
  summary: string;
}

const FORMAT_INSTRUCTIONS: Record<FormatStyle, string> = {
  plain: '',
  'annotated-index': `RESPONSE FORMAT INSTRUCTIONS:

1. Begin with a 1-sentence summary of the answer.

2. For each source, present findings as an annotated index using EXACTLY this structure:

**Source Title Here**

| Timestamp | Finding |
|-----------|---------|
| [02:13]   | Relay nodes proposed as fuel stations for missions |
| [09:40]   | Impossibilities usually engineering challenges not physics violations |

**Second Source Title**

| Timestamp | Finding |
|-----------|---------|
| [07:05]   | ISS decommissioning by 2031 transitions to commercial operators |
| [11:30]   | Self-assembling magnetic tiles for in-orbit construction |

CRITICAL RULES FOR TABLES:
- Each source gets its own **bold title** on a separate line above the table
- The table MUST have exactly 4 lines: header row, separator row, then data rows
- Header row is: \`| Timestamp | Finding |\`
- Separator row is: \`|-----------|---------|\`
- Each finding is ONE row: \`| [MM:SS]   | Finding text here |\` where MM:SS is the timestamp converted from T:ss markers in the source material (divide seconds by 60 for minutes, remainder for seconds)
- Blank line between the last table and the next **Source Title**

3. End with thematic tags on one line (e.g., "cyclusvergelijking · diversificatie · IPO-impact")

Rules:
- Max 12 words per finding — be telegraphic, drop filler, keep only the core fact
- Timestamps MUST use [MM:SS] format converted from T:ss markers in the source (T:420 becomes [07:00], T:538 becomes [08:58])
- Source title as **bold** text above each table, NOT a markdown heading (no ###)
- The source title provides video context — do NOT add inline citations or repeat video titles after individual findings
- No repetitive closing paragraph`,
};

export interface ChatContext {
  transcriptionJson: string;
  summary: string;
  compactText?: string;
  filterText?: string;
  history: Array<{ question: string; answer: string }>;
  question: string;
}

export interface MultiSignalChatContext {
  signals: ChatSignalContext[];
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
 * Reflects changes from issues #144-#147:
 * - #144: Added CompactTranscription (compact_text) to LLM response
 * - #145: DB column added, scope resolution updated for multi-signal chat
 * - #146: Multi-signal chat uses compactText when available, falls back to full transcription
 * - #147: Backfill script for historical signals without compact_text
 */
export function defaultPromptTemplate(): string {
  return `You are a content analyst specializing in concise, high-information summaries.

Analyze the following video transcription and produce a structured JSON response containing summary, key takeaways, overall sentiment, entity mentions, and a telegraphically compressed transcription (compact_text).

<filter_text>{FILTER_TEXT}</filter_text>

STEP 1: Determine relevance
- First evaluate whether the transcription contains meaningful discussion that matches the channel filter criteria.
- Content is relevant only if the filtered topic is discussed with substantive information, opinions, analysis, announcements, results, strategy, or news.
- Brief mentions, sponsor messages, introductions, greetings, or unrelated discussion do NOT make content relevant.

If the content does not meet the criteria:
Return ONLY:
{"relevant": false}

Do not generate summary, takeaways, sentiment, entities, or compact_text when relevant is false.

STEP 2: Summarize relevant content

Summary guidelines:
- Use an "inverted pyramid" structure: start with the most important conclusion, announcement, insight, or outcome.
- Capture what happened, why it matters, and any significant implications.
- Remove filler, repetition, jokes, greetings, sponsor content, and conversational noise.
- Focus only on content matching the filter criteria.
- Write 2-3 concise sentences.
- Prefer specific facts over vague descriptions.
- Do not speculate or invent information.

Takeaway guidelines:
- Extract the most important and actionable points.
- Each takeaway should represent a unique insight.
- Avoid repeating information already expressed in another takeaway.
- Use concise language.
- Include the timestamp corresponding to when the topic first appears.
- Maximum 8 takeaways.
- Order takeaways by importance, not chronology.

Sentiment guidelines:
Evaluate the overall sentiment of the relevant content only.

Score scale:
1 = Very Negative
2 = Negative
3 = Neutral
4 = Positive
5 = Very Positive

Entity extraction guidelines:
- Extract only entities that are materially discussed.
- Ignore passing mentions unless they are central to the discussion.
- Deduplicate entities (same entity mentioned multiple times = one entry).
- Determine sentiment toward each entity from the surrounding discussion.
- Use one of: card, set, player, format, archetype, company, event, rules, other

Entity sentiment values: Positive, Negative, Neutral

STEP 3: Produce CompactTranscription (compact_text)
- Generate a telegraphically compressed version of the full transcription.
- Remove filler words (um, uh, like, you know), function words (articles, prepositions, auxiliary verbs), and most punctuation.
- Keep all content words: nouns, main verbs, adjectives, proper names, numbers.
- Always preserve [T:ss] timestamp markers in their original positions throughout the text.
- Always keep negation words ("not", "no", "never") — they change meaning.

Example: "[T:0] So, um, the Kaldra set is, you know, not bad at all" -> "[T:0] Kaldra set not bad"

Return ONLY valid JSON with this exact structure:
{
  "title": "A concise title capturing the main topic, max 100 characters",
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
  "compact_text": "[T:0] telegraphically compressed transcription content words timestamps preserved negation kept",
  "relevant": true
}

Rules:
- Each takeaway must include a timestamp in "T:ss" format where ss is the start seconds as an integer
- Order takeaways by importance, not chronology
- Maximum 8 takeaways
- Focus only on topics matching the channel filter text

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

{FORMAT_INSTRUCTIONS}

<transcription>{TRANSCRIPTION}</transcription>

<summary>{SUMMARY}</summary>

{HISTORY}

<question>{QUESTION}</question>`;
}

/**
 * Strips HTML tags from a string, leaving only plain text content.
 */
function stripHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '');
}

/**
 * Formats history exchanges into nested XML blocks.
 * HTML tags are stripped from answers to prevent injecting markup into LLM prompts.
 */
function formatHistory(history: Array<{ question: string; answer: string }>): string {
  if (history.length === 0) return '';

  const exchanges = history.map((h) => {
    return `  <exchange>
    <question>${h.question}</question>
    <answer>${stripHtml(h.answer)}</answer>
  </exchange>`;
  }).join('\n');

  return `<history>\n${exchanges}\n</history>`;
}

/**
 * Assembles a chat prompt from a ChatContext.
 * Pure function: ChatContext → string. No DB access, no side effects.
 * Three-tier template resolution: customTemplate → defaultChatPromptTemplate()
 */
export function assembleChat(context: ChatContext, customTemplate?: string, formatStyle: FormatStyle = 'annotated-index'): string {
  const template = customTemplate ?? defaultChatPromptTemplate();
  const transcriptionText = context.compactText || formatTranscription(context.transcriptionJson);
  const historyText = formatHistory(context.history);

  return template
    .replace(/{FILTER_TEXT}/g, context.filterText || '')
    .replace(/{FORMAT_INSTRUCTIONS}/g, FORMAT_INSTRUCTIONS[formatStyle])
    .replace(/{TRANSCRIPTION}/g, transcriptionText)
    .replace(/{SUMMARY}/g, context.summary)
    .replace(/{HISTORY}/g, historyText)
    .replace(/{QUESTION}/g, context.question);
}

/**
 * Default multi-signal chat prompt template with XML signal blocks.
 * Uses same three-tier resolution pattern: customTemplate → this default.
 * Includes citation instruction for <> format when referencing specific signals.
 */
export function defaultMultiSignalChatPromptTemplate(): string {
  return `You are a content analyst. Answer the user's question based on the video transcriptions and summaries provided.

<filter_text>{FILTER_TEXT}</filter_text>

Group findings by source. The source title provides video context — do not add inline citations after individual findings.

{FORMAT_INSTRUCTIONS}

<signals>{SIGNALS}</signals>

{HISTORY}

<question>{QUESTION}</question>`;
}

/**
 * Formats a single ChatSignalContext into an XML signal block.
 * Uses compactText when available, falling back to formatted transcription.
 */
function formatSignalBlock(signal: ChatSignalContext): string {
  const content = signal.compactText ?? formatTranscription(signal.signalContext.transcriptionJson);
  const summary = signal.summary ?? '';

  return `  <signal video_id="${signal.videoId}" title="${signal.title}">
    <channel>${signal.channelDisplayName}</channel>
    <content>${content}</content>
    <summary>${summary}</summary>
  </signal>`;
}

/**
 * Formats multiple signals into an XML block string.
 */
function formatSignals(signals: ChatSignalContext[]): string {
  if (signals.length === 0) return '';

  return signals.map(formatSignalBlock).join('\n');
}

/**
 * Assembles a multi-signal chat prompt from a MultiSignalChatContext.
 * Pure function: MultiSignalChatContext → string. No DB access, no side effects.
 * Three-tier template resolution: customTemplate → defaultMultiSignalChatPromptTemplate()
 * @deprecated Use assembleAgentChat() for AgentChat with LLM tool calling
 */
export function assembleMultiSignalChat(context: MultiSignalChatContext, customTemplate?: string, formatStyle: FormatStyle = 'annotated-index'): string {
  const template = customTemplate ?? defaultMultiSignalChatPromptTemplate();
  const signalsText = formatSignals(context.signals);
  const historyText = formatHistory(context.history);

  return template
    .replace(/{FILTER_TEXT}/g, context.filterText || '')
    .replace(/{FORMAT_INSTRUCTIONS}/g, FORMAT_INSTRUCTIONS[formatStyle])
    .replace(/{SIGNALS}/g, signalsText)
    .replace(/{HISTORY}/g, historyText)
    .replace(/{QUESTION}/g, context.question);
}

// ─── AgentChat (issue #163) ──────────────────────────────────────

/**
 * Default agent chat prompt template with XML signal index and tool instructions.
 * Used for AgentChat: LLM reads signal index, decides relevance, calls get_compact_text tool.
 */
export function defaultAgentChatPromptTemplate(): string {
  return `You are a content analyst. Answer the user's question based on the video summaries provided.

You have access to a tool called get_compact_text that retrieves detailed transcription text for specific videos.

TOOL INSTRUCTIONS:
- First, read the signal index below to understand what videos are available and their topics.
- Based on the user's question, determine which videos are relevant.
- Call get_compact_text with the videoIds parameter containing an array of video IDs you want to retrieve.
- The tool will return {videoId, title, content} for each requested signal.
- Use the retrieved content to formulate your answer.

<signal_index>{SIGNAL_INDEX}</signal_index>

{HISTORY}

<question>{QUESTION}</question>`;
}

/**
 * Formats SignalIndexEntry[] into an XML block string.
 */
function formatSignalIndex(entries: SignalIndexEntry[]): string {
  if (entries.length === 0) return '';

  return entries.map((e) => `  <entry video_id="${e.videoId}" title="${e.title}">
    <summary>${e.summary}</summary>
  </entry>`).join('\n');
}

/**
 * Assembles an AgentChat prompt from lightweight signal index data.
 * Pure function: (signals, question, history) → string. No DB access, no side effects.
 * Three-tier template resolution: customTemplate → defaultAgentChatPromptTemplate()
 */
export function assembleAgentChat(
  signals: SignalIndexEntry[],
  question: string,
  history: Array<{ question: string; answer: string }>,
  customTemplate?: string
): string {
  const template = customTemplate ?? defaultAgentChatPromptTemplate();
  const signalIndexText = formatSignalIndex(signals);
  const historyText = formatHistory(history);

  return template
    .replace(/{SIGNAL_INDEX}/g, signalIndexText)
    .replace(/{HISTORY}/g, historyText)
    .replace(/{QUESTION}/g, question);
}
