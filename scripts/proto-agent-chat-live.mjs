/**
 * PROTOTYPE — AgentChat Q/A live LLM test
 * 
 * Tests the question/answer flow against a real LLM, logging everything.
 * Compares CURRENT vs MINIMAL prompt strategies.
 * 
 * Env: LLM_ENDPOINT (default http://127.0.0.1:1234/v1/chat/completions)
 *      LLM_MODEL  (default qwen/qwen3.6-27b)
 * 
 * Run: node scripts/proto-agent-chat-live.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ─── Config ──────────────────────────────────────────────────────────────

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen/qwen3.6-27b';
const DB_PATH = './data/mtgnews.db';

// ─── Tool definition (matches chat-manager.ts) ──────────────────────────

const GET_COMPACT_TEXT_TOOL = {
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

// ─── Signal index XML formatter (matches prompt-assembler.ts) ────────────

function formatSignalIndex(entries) {
  return entries.map((e) => `  <entry video_id="${e.videoId}" title="${e.title}">
    <summary>${e.summary}</summary>
  </entry>`).join('\n');
}

function buildAgentPrompt(signalIndex, question) {
  return `You are a content analyst. Answer the user's question based on the video summaries provided.

You have access to a tool called get_compact_text that retrieves detailed transcription text for specific videos.

TOOL INSTRUCTIONS:
- First, read the signal index below to understand what videos are available and their topics.
- Based on the user's question, determine which videos are relevant.
- Call get_compact_text with the videoIds parameter containing an array of video IDs you want to retrieve.
- The tool will return {videoId, title, content} for each requested signal.
- Use the retrieved content to formulate your answer.

<signal_index>${formatSignalIndex(signalIndex)}</signal_index>

<question>${question}</question>`;
}

// ─── CURRENT: full prompt every round (matches chat-conversation-state.ts) ──

function buildPromptCurrent(agentPrompt, turns) {
  if (turns.length === 0) return agentPrompt;
  const historyLines = turns.map(t => t.line).join('\n');
  return `${agentPrompt}\n\n--- CONVERSATION HISTORY ---\n${historyLines}`;
}

// ─── MINIMAL: drop signal index after round 1 ────────────────────────────

function buildPromptMinimal(question, turns) {
  if (turns.length === 0) {
    return buildAgentPrompt(loadSignalIndex(), question);
  }
  const historyLines = turns.map(t => t.line).join('\n');
  return `You are a content analyst. You previously called tools to retrieve video transcription data. Now answer the user's question based on the retrieved content.

<question>${question}</question>

--- CONVERSATION HISTORY ---
${historyLines}`;
}

// ─── DB helpers ──────────────────────────────────────────────────────────

let db = null;

function openDb() {
  try {
    db = new Database(DB_PATH);
    return true;
  } catch (e) {
    console.error(`Cannot open database at ${DB_PATH}: ${e.message}`);
    console.error('Create the database first with: npm run backfill or similar');
    return false;
  }
}

function loadSignalIndex() {
  if (!db) return [];
  const rows = db.prepare(
    'SELECT video_id, title, summary FROM signals WHERE compact_text IS NOT NULL AND compact_text != "" LIMIT 20'
  ).all();
  return rows.map(r => ({
    videoId: r.video_id,
    title: r.title || '(no title)',
    summary: r.summary || '(no summary)',
  }));
}

function executeGetCompactText(videoIds) {
  if (!db) return JSON.stringify([]);
  const results = [];
  for (const vid of videoIds) {
    const row = db.prepare(
      'SELECT video_id, title, compact_text FROM signals WHERE video_id = ?'
    ).get(vid);
    if (row && row.compact_text) {
      results.push({ videoId: row.video_id, title: row.title, content: row.compact_text });
    }
  }
  return JSON.stringify(results);
}

// ─── LLM call with tool calling (matches llm.ts streaming parser) ────────

async function callLlmWithTools(prompt) {
  const log = {
    promptBytes: new TextEncoder().encode(prompt).length,
    promptTokensEst: 0,
    sentAt: new Date().toISOString(),
  };

  const response = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      tools: [GET_COMPACT_TEXT_TOOL],
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentBuffer = '';
  const toolCalls = [];
  const toolAccum = new Map();
  let totalContent = '';

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
      if (data === '[DONE]') {
        // Finalize openai tool_calls
        for (const tc of toolAccum.values()) {
          toolCalls.push({ id: tc.id, name: tc.name, args: tc.args });
        }
        // Finalize qwen xml
        parseQwenXml(contentBuffer, toolCalls);
        break;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;

        if (parsed.usage?.completion_tokens !== undefined) {
          log.responseTokens = parsed.usage.completion_tokens;
        }

        // Handle standard tool_calls
        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let entry = toolAccum.get(idx);
            if (!entry) {
              entry = { id: tc.id ?? '', name: '', args: '' };
              toolAccum.set(idx, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }

        // Handle content (may contain Qwen XML tool calls)
        if (delta?.content) {
          contentBuffer += delta.content;
          totalContent += delta.content;
        }
      } catch {}
    }
  }
  reader.releaseLock();

  log.receivedAt = new Date().toISOString();
  log.responseBytes = new TextEncoder().encode(totalContent).length;

  return { toolCalls, content: totalContent.trim() || null, log };
}

// ─── Qwen XML parser (matches llm.ts) ────────────────────────────────────

function parseQwenXml(content, toolCallsList) {
  let remaining = content;

  // Format A
  const blockRegexA = /<tool_code>([\s\S]*?)<\/tool_code>/g;
  let matchA;
  while ((matchA = blockRegexA.exec(content)) !== null) {
    const blockContent = matchA[1];
    const paramValues = [];
    const paramRegex = /<parameter_code>([\s\S]*?)<\/parameter_code>/g;
    let pm;
    while ((pm = paramRegex.exec(blockContent)) !== null) {
      paramValues.push(pm[1].trim());
    }
    if (paramValues.length >= 2) {
      toolCallsList.push({
        id: `call_qwen_${Date.now()}_${toolCallsList.length}`,
        name: paramValues[0],
        args: paramValues.slice(1).join(' '),
      });
    }
    remaining = remaining.replace(matchA[0], '');
  }

  // Format B
  const blockRegexB = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let matchB;
  while ((matchB = blockRegexB.exec(remaining)) !== null) {
    const funcName = matchB[1];
    const innerBlock = matchB[2];
    const paramValues = {};
    const paramRegexB = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    let pmB;
    while ((pmB = paramRegexB.exec(innerBlock)) !== null) {
      try { paramValues[pmB[1]] = JSON.parse(pmB[2].trim()); } 
      catch { paramValues[pmB[1]] = pmB[2].trim(); }
    }
    if (Object.keys(paramValues).length > 0) {
      toolCallsList.push({
        id: `call_qwen_${Date.now()}_${toolCallsList.length}`,
        name: funcName,
        args: JSON.stringify(paramValues),
      });
    }
  }

  return remaining.trim();
}

// ─── Run one approach through the agent loop ──────────────────────────────

async function runApproach(name, buildPromptFn, question) {
  console.log('-'.repeat(80));
  console.log(`Approach: ${name}`);
  console.log('-'.repeat(80));

  const turns = [];
  const logs = [];
  let totalSentBytes = 0;
  let maxRounds = 3;

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0) {
      console.log();
    }

    // Build prompt
    let prompt;
    const signalIndex = loadSignalIndex();
    if (buildPromptFn === buildPromptCurrent) {
      const agentPrompt = buildAgentPrompt(signalIndex, question);
      prompt = buildPromptCurrent(agentPrompt, turns);
    } else {
      prompt = buildPromptMinimal(question, turns);
    }

    console.log(`\n  ROUND ${round + 1}:`);
    console.log(`  Prompt: ${prompt.length.toLocaleString()} bytes (~${Math.round(prompt.length / 4)} tokens)`);

    // Log what we're sending (truncated)
    const preview = prompt.length > 300 ? prompt.substring(0, 300) + '...' : prompt;
    console.log(`  SEND → ${preview}`);

    // Call LLM
    const { toolCalls, content, log } = await callLlmWithTools(prompt);
    totalSentBytes += log.promptBytes;
    logs.push(log);

    console.log(`  RECV ← ${log.responseBytes?.toLocaleString() ?? '?'} bytes (${log.responseTokens ?? '?'} tokens)`);

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        console.log(`  TOOL CALL: ${tc.name}(${tc.args})`);

        const toolResult = executeGetCompactText(JSON.parse(tc.args).videoIds);
        const toolBytes = new TextEncoder().encode(toolResult).length;
        console.log(`  TOOL RESULT: ${toolBytes.toLocaleString()} bytes`);

        // Log compact_text (truncated)
        const contentPreview = toolResult.length > 200 ? toolResult.substring(0, 200) + '...' : toolResult;
        console.log(`  TOOL DATA → ${contentPreview}`);

        turns.push({ line: `Assistant called ${tc.name}(${tc.args})` });
        turns.push({ line: `Tool Result (${tc.id}): ${toolResult}` });
      }
    } else if (content) {
      console.log(`  FINAL ANSWER (${content.length.toLocaleString()} bytes):`);
      const answerPreview = content.length > 400 ? content.substring(0, 400) + '...' : content;
      console.log(`  ANSWER → ${answerPreview}`);
      break; // Done
    } else {
      console.log(`  (empty response)`);
      break;
    }
  }

  console.log();
  console.log(`  TOTAL SENT to LLM: ${totalSentBytes.toLocaleString()} bytes (~${Math.round(totalSentBytes / 4)} tokens)`);
  
  const totalResponseBytes = logs.reduce((sum, l) => sum + (l.responseBytes || 0), 0);
  const totalTokens = logs.reduce((sum, l) => sum + (l.responseTokens || 0), 0);
  console.log(`  TOTAL RECEIVED from LLM: ${totalResponseBytes.toLocaleString()} bytes (~${totalTokens} tokens)`);
  console.log();

  return { name, totalSentBytes, totalResponseBytes, totalTokens };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(80));
  console.log('PROTOTYPE: AgentChat Q/A Live LLM Test');
  console.log(`Endpoint: ${LLM_ENDPOINT}`);
  console.log(`Model: ${LLM_MODEL}`);
  console.log('='.repeat(80));

  // Open DB
  if (!openDb()) {
    console.log('\nNo database found — running with MOCK data instead.');
    console.log('Run "node scripts/proto-agent-chat.mjs" for the mock version.');
    process.exit(1);
  }

  const signalIndex = loadSignalIndex();
  if (signalIndex.length === 0) {
    console.log('\nNo signals with compact_text found in database.');
    console.log('Run "node scripts/proto-agent-chat.mjs" for the mock version.');
    db.close();
    process.exit(1);
  }

  const question = process.argv[2] || 'What are the main topics discussed across these videos?';
  
  console.log(`\nSignals loaded: ${signalIndex.length}`);
  console.log(`Question: "${question}"`);
  console.log();

  // Log signal index being sent
  const indexXml = formatSignalIndex(signalIndex);
  const indexBytes = new TextEncoder().encode(indexXml).length;
  console.log(`Signal index size: ${indexBytes.toLocaleString()} bytes (~${Math.round(indexBytes / 4)} tokens)`);
  
  // Show first 2 entries as sample
  for (const entry of signalIndex.slice(0, 2)) {
    console.log(`  - [${entry.videoId}] ${entry.title}: ${entry.summary.substring(0, 80)}...`);
  }
  if (signalIndex.length > 2) console.log(`  ... and ${signalIndex.length - 2} more`);
  console.log();

  // Run both approaches
  const currentResult = await runApproach('CURRENT (full prompt every round)', buildPromptCurrent, question);
  const minimalResult = await runApproach('MINIMAL (drop index after round 1)', buildPromptMinimal, question);

  // Comparison
  console.log('='.repeat(80));
  console.log('COMPARISON');
  console.log('='.repeat(80));
  console.log();
  console.log(`  CURRENT total sent:  ${currentResult.totalSentBytes.toLocaleString().padStart(10)} bytes (~${Math.round(currentResult.totalSentBytes / 4).toLocaleString()} tokens)`);
  console.log(`  MINIMAL total sent:  ${minimalResult.totalSentBytes.toLocaleString().padStart(10)} bytes (~${Math.round(minimalResult.totalSentBytes / 4).toLocaleString()} tokens)`);
  
  const saved = currentResult.totalSentBytes - minimalResult.totalSentBytes;
  const savedPercent = Math.round((saved / currentResult.totalSentBytes) * 100);
  console.log();
  console.log(`  SAVED: ${saved.toLocaleString()} bytes (~${Math.round(saved / 4)} tokens, ${savedPercent}% reduction)`);
  console.log();

  if (saved > indexBytes * 0.5) {
    console.log('  VERDICT: MINIMAL approach saves significant data on Round 2+.');
    console.log('  The signal index is redundant after the LLM has already called tools.');
  } else {
    console.log('  VERDICT: Savings are marginal — may not be worth the complexity.');
  }

  console.log();
  console.log('='.repeat(80));

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});