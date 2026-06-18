"use strict";
import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';

// ── DB setup ────────────────────────────────────────────────
const DB_PATH = process.env.MTGDB_PATH || path.join(process.cwd(), 'data', 'mtgnews.db');
const db = new Database(DB_PATH);

// Grab the first signal with transcription
const sig = db.prepare(`
  SELECT s.video_id, s.transcription, s.title, c.display_name
  FROM signals s
  LEFT JOIN channels c ON s.channel_id = c.channel_id
  WHERE s.transcription IS NOT NULL
  ORDER BY s.created_at DESC
  LIMIT 1
`).get();

if (!sig) {
  console.error('No signals found in the database.');
  db.close();
  process.exit(1);
}

console.log(`Signal: ${sig.video_id}`);
console.log(`Title:  ${sig.title || '(none)'}`);
console.log(`Channel: ${sig.display_name || '(unknown)'}`);

// ── Build transcription text (same format as PromptAssembler) ──
const segments = JSON.parse(sig.transcription);
const transcriptionText = segments.map((s) => {
  const secs = Math.floor(s.time / 1000);
  return `[T:${secs}] ${s.text}`;
}).join(' ');

console.log(`Transcription length: ${transcriptionText.length} chars (~${Math.round(transcriptionText.length / 4)} tokens est.)`);
console.log('');

// ── Build a minimal prompt ──────────────────────────────────
const prompt = `<transcription>
${transcriptionText.substring(0, 15000)}
</transcription>

Please provide a brief summary of this transcription in 3-5 bullet points.`;

console.log(`Prompt length: ${prompt.length} chars`);
console.log('');

// ── LLM config ──────────────────────────────────────────────
const endpoint = process.env.LLM_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions';
const model  = process.env.LLM_MODEL || 'qwen/qwen3.6-27b';

console.log(`Endpoint: ${endpoint}`);
console.log(`Model:    ${model}`);
console.log('');
console.log('=== STARTING STREAMING CALL ===\n');

// ── Streaming call with maximum info logging ────────────────
const requestStart = Date.now();
const tokenTimestamps = [];   // track per-token arrival times
let tokenIndex = 0;
let reasoningTokenIndex = 0;
let totalReasoningChars = 0;

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      // Request usage stats in the final chunk (OpenAI-compatible)
      stream_options: { include_usage: true },
    }),
  });

  const responseTime = Date.now();
  console.log(`--- Response Headers (first ${responseTime - requestStart}ms) ---`);
  console.log(`Status: ${response.status} ${response.statusText}`);

  // Dump ALL response headers
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }
  console.log('');

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`HTTP Error ${response.status}: ${errBody.substring(0, 500)}`);
    db.close();
    process.exit(1);
  }

  if (!response.body) {
    console.error('Response has no body (streaming failed).');
    db.close();
    process.exit(1);
  }

  // ── Consume the SSE stream ────────────────────────────────
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sseLineCount = 0;
  let dataLineCount = 0;
  let jsonParseErrors = 0;
  let totalContentChars = 0;
  const firstTokenTime = null;

  console.log('--- SSE Stream (raw + parsed) ---\n');

  // Capture first non-empty content token timing
  let firstContentLogged = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkArrivalTime = Date.now();
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        sseLineCount++;
        const trimmed = line.trimEnd();

        // Log EVERY raw SSE line (prefix with [RAW])
        console.log(`  [RAW #${sseLineCount}] "${trimmed}"`);

        if (!trimmed.startsWith('data: ')) continue;
        dataLineCount++;

        const data = trimmed.slice(6);

        if (data === '[DONE]') {
          console.log(`  [SSE DONE marker received]`);
          continue;
        }

        // Try to parse JSON payload
        try {
          const parsed = JSON.parse(data);

          // Log the full raw JSON object (collapsed)
          console.log(`  [JSON #${dataLineCount}] ${JSON.stringify(parsed).substring(0, 300)}${JSON.stringify(parsed).length > 300 ? '...' : ''}`);

          // Extract reasoning_content (Chain of Thought / internal reasoning)
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
          if (reasoning) {
            reasoningTokenIndex++;
            totalReasoningChars += reasoning.length;

            if (reasoningTokenIndex === 1) {
              console.log(`\n  >>> REASONING START @${Date.now() - requestStart}ms <<<`);
            }

            const elapsed = Date.now() - requestStart;
            if (reasoningTokenIndex % 50 === 1) {
              console.log(`  [REASONING #${reasoningTokenIndex} @${elapsed}ms] (${reasoning.length} chars) "${reasoning.substring(0, 60)}..."`);
            }
          }

          // Extract content delta (visible output)
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            tokenIndex++;
            totalContentChars += content.length;
            tokenTimestamps.push(Date.now());

            if (tokenIndex === 1) {
              const timeToFirstToken = Date.now() - requestStart;
              console.log(`\n  >>> CONTENT START (first visible token) @${timeToFirstToken}ms <<<`);
              console.log('');
              firstContentLogged = true;
            }

            // Log each token with timing info
            const elapsed = Date.now() - requestStart;
            if (tokenIndex % 10 === 1 || content.length > 1) {
              // Log every 10th token start, or tokens that look meaningful
              console.log(`  [TOKEN #${tokenIndex} @${elapsed}ms] (${content.length} chars) "${content}"`);
            }
          }

          // Log finish reason if present
          if (parsed.choices?.[0]?.finish_reason) {
            console.log(`\n  [FINISH_REASON: ${parsed.choices[0].finish_reason}]`);
          }

          // Log usage stats if present (final chunk with stream_options)
          if (parsed.usage) {
            console.log(`\n  --- Usage Stats (from LLM response) ---`);
            console.log(`    prompt_tokens:      ${parsed.usage.prompt_tokens}`);
            console.log(`    completion_tokens:   ${parsed.usage.completion_tokens}`);
            console.log(`    total_tokens:        ${parsed.usage.total_tokens}`);
            if (parsed.usage.prompt_time !== undefined) {
              console.log(`    prompt_time (s):     ${parsed.usage.prompt_time}`);
            }
            if (parsed.usage.prompt_tokens_per_second !== undefined) {
              console.log(`    prompt_tps:          ${parsed.usage.prompt_tokens_per_second}`);
            }
            if (parsed.usage.completion_time !== undefined) {
              console.log(`    completion_time (s): ${parsed.usage.completion_time}`);
            }
            if (parsed.usage.tokens_per_second !== undefined) {
              console.log(`    generation_tps:      ${parsed.usage.tokens_per_second}`);
            }
          }

          // Log LM Studio-specific stats (speculative decoding / MTP)
          if (parsed.stats) {
            console.log(`\n  --- LM Studio Stats (MTP/Speculative Decoding) ---`);
            console.log(`    total_draft_tokens:      ${parsed.stats.total_draft_tokens_count ?? 'N/A'}`);
            console.log(`    accepted_draft_tokens:   ${parsed.stats.accepted_draft_tokens_count ?? 'N/A'}`);
            console.log(`    rejected_draft_tokens:   ${parsed.stats.rejected_draft_tokens_count ?? 'N/A'}`);
          }

          // Log completion_tokens_details (reasoning vs visible)
          if (parsed.usage?.completion_tokens_details) {
            const details = parsed.usage.completion_tokens_details;
            console.log(`\n  --- Token Breakdown (from usage) ---`);
            console.log(`    reasoning_tokens:        ${details.reasoning_tokens ?? 'N/A'}`);
          }

          // Log id, model, created fields from first chunk
          if (dataLineCount === 1 && parsed.id) {
            console.log(`\n  --- Request Metadata (from first chunk) ---`);
            console.log(`    id:      ${parsed.id}`);
            console.log(`    model:   ${parsed.model || '(not returned)'}`);
            console.log(`    created: ${parsed.created || '(not returned)'}`);
            console.log(`    object:  ${parsed.object || '(not returned)'}`);
          }

        } catch (parseErr) {
          jsonParseErrors++;
          console.log(`  [PARSE_ERROR #${jsonParseErrors}] "${data.substring(0, 100)}"`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // ── Summary Statistics ────────────────────────────────────
  const totalTime = Date.now() - requestStart;
  console.log('\n\n========================================');
  console.log('  STREAMING CALL — SUMMARY STATISTICS');
  console.log('========================================\n');

  console.log(`--- Timing ---`);
  console.log(`  Total wall-clock time:    ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
  console.log(`  Time to response headers: ${responseTime - requestStart}ms`);
  if (firstContentLogged && tokenTimestamps.length > 0) {
    const timeToFirstToken = tokenTimestamps[0] - requestStart;
    console.log(`  Time to first token:      ${timeToFirstToken}ms`);
    const generationTime = tokenTimestamps[tokenTimestamps.length - 1] - tokenTimestamps[0];
    console.log(`  Generation time (first→last): ${generationTime}ms`);
    if (tokenTimestamps.length > 1) {
      const avgTokenInterval = generationTime / (tokenTimestamps.length - 1);
      console.log(`  Avg token interval:       ${avgTokenInterval.toFixed(2)}ms (${(1000 / avgTokenInterval).toFixed(1)} tokens/s)`);
    }
  }

  console.log(`\n--- Stream Info ---`);
  console.log(`  Total SSE lines received: ${sseLineCount}`);
  console.log(`  Data lines (data: ...):   ${dataLineCount}`);
  console.log(`  JSON parse errors:        ${jsonParseErrors}`);
  console.log(`  Reasoning token chunks:   ${reasoningTokenIndex} (${totalReasoningChars} chars)`);
  console.log(`  Content token chunks:     ${tokenIndex} (${totalContentChars} chars)`);

  console.log(`\n--- Request Info ---`);
  console.log(`  Prompt length:            ${prompt.length} chars`);
  console.log(`  Endpoint:                 ${endpoint}`);
  console.log(`  Model:                    ${model}`);
  console.log(`  stream_options used:      true (include_usage)`);

  console.log('\n========================================\n');

} catch (error) {
  console.error(`Streaming call failed: ${error.message}`);
  console.error(error.stack);
} finally {
  db.close();
}