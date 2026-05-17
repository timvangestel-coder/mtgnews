/**
 * Diagnostic script: calls the LLM directly to inspect the response format.
 * Usage: npx tsx scripts/test-llm-response.ts
 * 
 * Tests all 3 prompts (summary, sentiment, entities) with a sample transcription
 * to identify what the LLM actually returns.
 */

import dotenv from 'dotenv';
dotenv.config(); // Load .env file so getLlmConfig picks up the correct model

import { getLlmConfig } from '../src/llm';

const SAMPLE_TRANSCRIPTION = JSON.stringify([
  { text: "Welcome back to another video everyone.", start: 0, end: 3 },
  { text: "Today we're talking about the new Kaldra set.", start: 3, end: 8 },
  { text: "This set introduces three legendary creatures.", start: 8, end: 13 },
  { text: "The first is Kaldra, the Faceless — a 4/4 legendary Human Warrior.", start: 13, end: 20 },
  { text: "It has hexproof and deathtouch.", start: 20, end: 24 },
  { text: "The second legendary is Aegis of the Void, a 3/3 legendary Artifact Golem.", start: 24, end: 32 },
  { text: "It has trample and when it dies, draw two cards.", start: 32, end: 38 },
  { text: "Finally there's Swiftblade Veteran, a 2/1 creature with haste.", start: 38, end: 45 },
  { text: "Overall I think this set is very positive for the format.", start: 45, end: 52 },
  { text: "The cards are well-designed and the artwork is stunning.", start: 52, end: 58 },
]);

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

async function callLlm(prompt: string, callName: string): Promise<{ ok: boolean; content: string; rawText: string }> {
  const config = getLlmConfig();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`CALL: ${callName}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`Model: ${config.model}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Prompt length: ${prompt.length} chars`);
  console.log(`\n--- Sending request ---`);

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`\n⚠️ AbortController firing after 300s...`);
    controller.abort();
  }, 300_000);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n--- HTTP Response ---`);
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`OK: ${response.ok}`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);
    console.log(`Content-Length: ${response.headers.get('content-length')}`);
    console.log(`Connection: ${response.headers.get('connection')}`);
    console.log(`Time: ${elapsed}s`);

    // Read raw body text first (critical: always read the raw body)
    const rawText = await response.text();
    console.log(`\n--- Raw body (${rawText.length} chars) ---`);
    console.log(rawText);
    console.log(`\n--- End raw body ---`);

    // Parse JSON
    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return { ok: false, content: rawText, rawText };
    }

    // Check structure
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.log(`\n⚠️ NO CONTENT found in response`);
      console.log(`choices: ${JSON.stringify(data.choices, null, 2)}`);
      return { ok: false, content: '', rawText };
    }

    console.log(`\n--- LLM content (${content.length} chars) ---`);
    console.log(content);
    console.log(`\n--- End content ---`);

    // Try to parse content as JSON
    let jsonParsed: any;
    try {
      let jsonStr = content.trim();
      const markdownMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (markdownMatch) {
        console.log(`\n⚠️ Stripped markdown code blocks`);
        jsonStr = markdownMatch[1].trim();
      }
      jsonParsed = JSON.parse(jsonStr);
      console.log(`\n--- Parsed LLM JSON ---`);
      console.log(JSON.stringify(jsonParsed, null, 2));
      console.log(`\n--- End parsed JSON ---`);
    } catch (e) {
      console.log(`\n⚠️ JSON PARSE FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { ok: true, content, rawText };
  } catch (error) {
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n--- ERROR after ${elapsed}s} ---`);
    console.error(`Error type: ${error instanceof Error ? error.constructor.name : 'N/A'}`);
    console.error(`Error name: ${error instanceof Error ? error.name : 'N/A'}`);
    console.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`\nStack:\n${error.stack}`);
    }
    return { ok: false, content: error instanceof Error ? error.message : String(error), rawText: '' };
  }
}

async function main() {
  console.log('MTG News LLM Response Diagnostic');
  console.log(`Time: ${new Date().toISOString()}`);

  const transcriptionText = extractTranscriptionText(SAMPLE_TRANSCRIPTION);
  console.log(`\nExtracted transcription text (${transcriptionText.length} chars):`);
  console.log(transcriptionText);

  // Call all 3 LLM endpoints
  const summaryResult = await callLlm(buildSummaryPrompt(transcriptionText), 'SUMMARY');
  await new Promise(r => setTimeout(r, 1000)); // brief pause between calls

  const sentimentResult = await callLlm(buildSentimentPrompt(transcriptionText), 'SENTIMENT');
  await new Promise(r => setTimeout(r, 1000));

  const entitiesResult = await callLlm(buildEntityPrompt(transcriptionText), 'ENTITIES');

  // Summary
  console.log(`\n\n${'#'.repeat(70)}`);
  console.log('FINAL RESULTS');
  console.log(`${'#'.repeat(70)}`);

  console.log(`\n1. SUMMARY: ok=${summaryResult.ok}, content_length=${summaryResult.content.length}`);
  if (summaryResult.ok) {
    try {
      let jsonStr = summaryResult.content.trim();
      const markdownMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (markdownMatch) jsonStr = markdownMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      console.log('   JSON parse: OK');
      console.log(`   Has "summary": ${'summary' in parsed}`);
      console.log(`   Has "takeaways": ${'takeaways' in parsed}`);
      console.log(`   Takeaways count: ${Array.isArray(parsed.takeaways) ? parsed.takeaways.length : 'N/A'}`);
    } catch (e) {
      console.log(`   JSON parse: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n2. SENTIMENT: ok=${sentimentResult.ok}, content_length=${sentimentResult.content.length}`);
  if (sentimentResult.ok) {
    try {
      let jsonStr = sentimentResult.content.trim();
      const markdownMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (markdownMatch) jsonStr = markdownMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      console.log('   JSON parse: OK');
      console.log(`   Score: ${parsed.score}, Label: ${parsed.label}`);
    } catch (e) {
      console.log(`   JSON parse: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n3. ENTITIES: ok=${entitiesResult.ok}, content_length=${entitiesResult.content.length}`);
  if (entitiesResult.ok) {
    try {
      let jsonStr = entitiesResult.content.trim();
      const markdownMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (markdownMatch) jsonStr = markdownMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      console.log('   JSON parse: OK');
      console.log(`   Entity count: ${Array.isArray(parsed) ? parsed.length : 'N/A'}`);
    } catch (e) {
      console.log(`   JSON parse: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch(console.error);