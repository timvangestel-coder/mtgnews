import type { ToolCall } from './llm';

/** A single turn in the agent conversation */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** Lightweight signal entry for the agent index (matches prompt-assembler.ts SignalIndexEntry) */
export interface SignalIndexEntry {
  videoId: string;
  title: string;
  summary: string;
}

/** Round-aware conversation that drops the signal index after Round 1.  

The signal index is only needed for Round 1 when the LLM decides which tools to call. After that, the LLM already has compact_text and doesn't need the index again — saving ~35% of tokens on multi-round conversations.
 */
export interface AgentConversation {
  /** Record a tool call and its result */
  addToolCall(toolCall: ToolCall, result: string): void;
  /** Build the prompt for the next LLM call. Round 1 includes signal index; Round 2+ drops it. */
  buildNextPrompt(): string;
}

/**
 * Manages agent conversation state across rounds.
 *
 * Maintains turns as a flat list so buildPrompt() always produces
 * a clean prompt: base + serialized turns, without recursive nesting.
 *
 * Deep interface: 2 methods behind a small seam at createConversationState().
 */
export interface ConversationState {
  /** Add a turn (assistant tool call, tool result, or user follow-up) */
  addTurn(turn: ConversationTurn): void;

  /**
   * Build the complete prompt for the next LLM call.
   * Returns basePrompt + all turns serialized as flat history lines.
   * Never re-embeds prior rounds — the base prompt appears exactly once.
   */
  buildPrompt(basePrompt: string): string;
}

/**
 * Creates a conversation state manager that avoids recursive nesting
 * by maintaining turns as a flat list rather than embedding them
 * into the base prompt.
 */
export function createConversationState(): ConversationState {
  const turns: ConversationTurn[] = [];

  return {
    addTurn(turn) {
      turns.push(turn);
    },

    buildPrompt(basePrompt) {
      if (turns.length === 0) {
        return basePrompt;
      }

      const historyLines = turns
        .map((t) => {
          if (t.role === 'assistant' && t.toolCalls) {
            const tc = t.toolCalls[0];
            return `Assistant called ${tc.function.name}(${tc.function.arguments})`;
          }
          if (t.role === 'tool') {
            return `Tool Result (${t.toolCallId}): ${t.content}`;
          }
          // user and other roles are silently ignored in serialization
          return '';
        })
        .filter(Boolean)
        .join('\n');

      return `${basePrompt}\n\n--- CONVERSATION HISTORY ---\n${historyLines}`;
    },
  };
}

// ─── AgentConversation (round-aware, drops signal index after Round 1) ──

/** Strips HTML tags from a string */
function stripHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '');
}

/** Format chat history as XML exchanges */
function formatHistory(history: Array<{ question: string; answer: string }>): string {
  if (history.length === 0) return '';
  const exchanges = history.map((h) =>
    `  <exchange>\n    <question>${h.question}</question>\n    <answer>${stripHtml(h.answer)}</answer>\n  </exchange>`
  ).join('\n');
  return `<history>\n${exchanges}\n</history>`;
}

/** Format signal index as XML entries */
function formatSignalIndex(entries: SignalIndexEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) =>
    `  <entry video_id="${e.videoId}" title="${e.title}">\n    <summary>${e.summary}</summary>\n  </entry>`
  ).join('\n');
}

/** Format instructions for chat answers — table format with timestamps */
const FORMAT_INSTRUCTIONS = `RESPONSE FORMAT INSTRUCTIONS:

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
- No repetitive closing paragraph`;

/** Round-1 system prompt (with tool instructions and signal index).
    Format instructions are included because some questions can be answered from summaries alone — no tool call needed. */
function roundOnePrompt(signalIndex: SignalIndexEntry[], question: string, history: Array<{ question: string; answer: string }>): string {
  const signalXml = formatSignalIndex(signalIndex);
  const historyXml = formatHistory(history);

  return `You are a content analyst. Answer the user's question based on the video summaries provided.

You have access to a tool called get_compact_text that retrieves detailed transcription text for specific videos by their video IDs.

TOOL INSTRUCTIONS:
- First, read the signal index below to understand what videos are available and their topics.
- Based on the user's question, determine which videos are relevant.
- Call get_compact_text with the videoIds parameter containing an array of video IDs you want to retrieve.
- The tool will return {videoId, title, content} for each requested signal.
- Use the retrieved content to formulate your answer.
- If the summaries alone contain enough information to answer the question, you may skip the tool call and answer directly.

${FORMAT_INSTRUCTIONS}

<signal_index>${signalXml}</signal_index>

${historyXml}

<question>${question}</question>`;
}

/** Round 2+ system prompt (no signal index — LLM already has what it needs) */
function roundPlusPrompt(question: string, historyLines: string): string {
  return `You are a content analyst. You previously called tools to retrieve video transcription data. Now answer the user's question based on the retrieved content.

${FORMAT_INSTRUCTIONS}

<question>${question}</question>

--- CONVERSATION HISTORY ---
${historyLines}`;
}

/**
 * Creates a round-aware conversation manager for AgentChat.
 * 
 * Round 1: emits full prompt with signal index (LLM needs it to pick tools).
 * Round 2+: drops signal index, keeps only question + tool call/results.
 */
export function createAgentConversation(
  signalIndex: SignalIndexEntry[],
  question: string,
  history: Array<{ question: string; answer: string }>
): AgentConversation {
  const toolTurns: string[] = [];
  let isFirstRound = true;

  return {
    addToolCall(toolCall, result) {
      toolTurns.push(`Assistant called ${toolCall.function.name}(${toolCall.function.arguments})`);
      toolTurns.push(`Tool Result (${toolCall.id}): ${result}`);
    },

    buildNextPrompt() {
      if (isFirstRound) {
        isFirstRound = false;
        return roundOnePrompt(signalIndex, question, history);
      }

      const historyLines = toolTurns.join('\n');
      return roundPlusPrompt(question, historyLines);
    },
  };
}
