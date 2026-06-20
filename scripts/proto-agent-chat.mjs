/**
 * PROTOTYPE — AgentChat Q/A data efficiency test
 * 
 * Question: How much data is sent to the LLM in each round of the agent loop,
 * and can we reduce it by dropping the full signal index from Round 2+?
 * 
 * Two modes:
 * - "current": sends full agentPrompt (signal index + question) on every round
 * - "minimal": sends only the question + tool results on rounds 2+
 * 
 * Logs everything sent and received. Does NOT hit a real LLM — uses a mock.
 * Run: node scripts/proto-agent-chat.mjs
 */

// ─── Mock data (realistic sizes) ────────────────────────────────────────

const SIGNAL_INDEX = [
  { videoId: "abc1", title: "MTG Set Review: Kaldra Complete Analysis", summary: "Deep dive into the final cards of Kaldra set, power level discussion, format impact on Standard and Commander." },
  { videoId: "abc2", title: "Magic Finance Weekly: Stock Updates June 2026", summary: "Weekly price movements for key MTG investments. Black Lotus stable, Moon Mirage rising, Power Nine trends analysis." },
  { videoId: "abc3", title: "Premier Format News: Banned List Speculation", summary: "Discussion about potential Standard banned list changes after Kaldra release. Aggro decks too fast, control too slow." },
  { videoId: "abc4", title: "Commander Castoff: Budget Red Green Stompy", summary: "Building a competitive red-green stompy deck for under $50 using Kaldra commons and uncommons." },
  { videoId: "abc5", title: "MTG Arena Update: New Features and Bug Fixes", summary: "Arena client update with new collection management tools, tournament mode improvements, known bug fixes." },
];

const COMPACT_TEXT_SAMPLES = {
  abc1: "[T:0] Kaldra complete set review final thoughts [T:45] creature design excellent average power high [T:120] removal spells efficient price point good [T:300] format impact standard aggro decks stronger [T:480] commander staples emerging mindbreak assassin top tier [T:600] metagame shift expected control decks need answers",
  abc2: "[T:0] finance weekly update june prices [T:60] black lotus stable range $500k-$550k [T:180] moon Mirage rising 3 percent this week [T:300] power nine trends upward long term [T:420] modern staples price analysis golek foundry holding",
  abc3: "[T:0] banned list speculation standard format [T:90] aggro decks running circles control too fast [T:210] bone crush already gone what next [T:360] potential targets murder at the moment certain standard legal [T:500] paper standard divide growing online players frustrated",
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

// ─── "Current" approach: full prompt every round (matches chat-conversation-state.ts) ──

function buildPromptCurrent(agentPrompt, rounds) {
  if (rounds.length === 0) return agentPrompt;
  const historyLines = rounds.map(r => r.line).join('\n');
  return `${agentPrompt}\n\n--- CONVERSATION HISTORY ---\n${historyLines}`;
}

// ─── "Minimal" approach: drop signal index after round 1 ────────────────

function buildPromptMinimal(question, rounds) {
  if (rounds.length === 0) {
    // Round 1: full prompt with signal index (same as current)
    return buildAgentPrompt(SIGNAL_INDEX, question);
  }
  // Rounds 2+: only question + tool results, no signal index
  const historyLines = rounds.map(r => r.line).join('\n');
  return `You are a content analyst. You previously called tools to retrieve video transcription data. Now answer the user's question based on the retrieved content.

<question>${question}</question>

--- CONVERSATION HISTORY ---
${historyLines}`;
}

// ─── Mock LLM that simulates tool calling ────────────────────────────────

function mockLlmRound(prompt, roundNum) {
  const promptBytes = new TextEncoder().encode(prompt).length;
  const tokenEstimate = Math.round(promptBytes / 4); // ~4 bytes per token on average
  
  // Simulate what the LLM would return
  let result;
  if (roundNum === 0) {
    // Round 1: LLM reads index, calls get_compact_text for relevant videos
    result = {
      toolCalls: [{
        id: 'call_1',
        function: { name: 'get_compact_text', arguments: JSON.stringify({ videoIds: ["abc1", "abc3"] }) }
      }],
      content: null,
    };
  } else {
    // Round 2+: LLM has compact text, produces final answer
    result = {
      toolCalls: [],
      content: "**Kaldra Set Impact on Standard**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:300]   | Format impact standard aggro decks stronger |\n| [T:480]   | Commander staples emerging mindbreak assassin top tier |\n\n**Banned List Speculation**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:90]    | Aggro decks running circles control too fast |\n| [T:360]   | Potential targets murder at the moment certain standard legal |\n\nset analysis · format impact · banned speculation",
    };
  }
  
  // Simulate response size
  const responseBytes = result.content ? new TextEncoder().encode(result.content).length : 0;
  const responseTokens = Math.round(responseBytes / 4);
  
  return { promptBytes, tokenEstimate, result, responseBytes, responseTokens };
}

function executeTool(videoIds) {
  const results = [];
  for (const vid of videoIds) {
    if (COMPACT_TEXT_SAMPLES[vid]) {
      results.push({ videoId: vid, title: SIGNAL_INDEX.find(s => s.videoId === vid)?.title || vid, content: COMPACT_TEXT_SAMPLES[vid] });
    }
  }
  return JSON.stringify(results);
}

// ─── Run simulation ──────────────────────────────────────────────────────

const question = "What is being said about the Standard format and potential bans?";

console.log('='.repeat(80));
console.log('PROTOTYPE: AgentChat Q/A Data Efficiency Test');
console.log('='.repeat(80));
console.log();
console.log(`Question: "${question}"`);
console.log(`Signals in index: ${SIGNAL_INDEX.length}`);
console.log();

// Simulate both approaches through 2 rounds
const approaches = [
  { name: 'CURRENT (full prompt every round)', buildPrompt: buildPromptCurrent },
  { name: 'MINIMAL (drop signal index after round 1)', buildPrompt: buildPromptMinimal },
];

for (const approach of approaches) {
  console.log('-'.repeat(80));
  console.log(`Approach: ${approach.name}`);
  console.log('-'.repeat(80));
  
  const rounds = [];
  let totalSentBytes = 0;
  let totalReceivedBytes = 0;
  let maxRounds = 2;
  
  for (let round = 0; round < maxRounds; round++) {
    // Build prompt for this round
    let prompt;
    if (approach.buildPrompt === buildPromptCurrent) {
      const agentPrompt = buildAgentPrompt(SIGNAL_INDEX, question);
      prompt = approach.buildPrompt(agentPrompt, rounds);
    } else {
      prompt = approach.buildPrompt(question, rounds);
    }
    
    // Call mock LLM
    const { promptBytes, tokenEstimate, result, responseBytes, responseTokens } = mockLlmRound(prompt, round);
    
    console.log();
    console.log(`  ROUND ${round + 1}:`);
    console.log(`  Prompt size: ${promptBytes.toLocaleString()} bytes (~${tokenEstimate.toLocaleString()} tokens)`);
    
    // Log prompt structure (truncated)
    const promptPreview = prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt;
    console.log(`  Prompt preview: ${promptPreview}`);
    
    if (result.toolCalls.length > 0) {
      for (const tc of result.toolCalls) {
        console.log(`  → LLM called: ${tc.function.name}(${tc.function.arguments})`);
        
        // Execute tool
        const toolResult = executeTool(JSON.parse(tc.function.arguments).videoIds);
        const toolResultBytes = new TextEncoder().encode(toolResult).length;
        console.log(`  ← Tool result: ${toolResultBytes.toLocaleString()} bytes`);
        
        // Log compact_text content (truncated)
        const contentPreview = toolResult.length > 150 ? toolResult.substring(0, 150) + '...' : toolResult;
        console.log(`  Tool result preview: ${contentPreview}`);
        
        // Add to conversation history (matches chat-conversation-state.ts serialization)
        rounds.push({
          line: `Assistant called ${tc.function.name}(${tc.function.arguments})`
        });
        rounds.push({
          line: `Tool Result (${tc.id}): ${toolResult}`
        });
        
        totalReceivedBytes += toolResultBytes;
      }
    } else if (result.content) {
      console.log(`  → Final answer: ${responseBytes.toLocaleString()} bytes (~${responseTokens} tokens)`);
      const answerPreview = result.content.length > 150 ? result.content.substring(0, 150) + '...' : result.content;
      console.log(`  Answer preview: ${answerPreview}`);
      totalReceivedBytes += responseBytes;
    }
    
    totalSentBytes += promptBytes;
  }
  
  console.log();
  console.log(`  TOTAL DATA SENT to LLM: ${totalSentBytes.toLocaleString()} bytes (~${Math.round(totalSentBytes / 4).toLocaleString()} tokens)`);
  console.log(`  TOTAL DATA RECEIVED from LLM/tools: ${totalReceivedBytes.toLocaleString()} bytes`);
  console.log();
}

// ─── Comparison ──────────────────────────────────────────────────────────

console.log('='.repeat(80));
console.log('COMPARISON');
console.log('='.repeat(80));

const agentPrompt = buildAgentPrompt(SIGNAL_INDEX, question);
const indexBytes = new TextEncoder().encode(formatSignalIndex(SIGNAL_INDEX)).length;
const promptOverhead = new TextEncoder().encode(agentPrompt.replace(formatSignalIndex(SIGNAL_INDEX), '')).length;

console.log();
console.log(`Signal index size: ${indexBytes.toLocaleString()} bytes (~${Math.round(indexBytes / 4)} tokens)`);
console.log(`Prompt overhead (system + tool instructions): ${promptOverhead.toLocaleString()} bytes (~${Math.round(promptOverhead / 4)} tokens)`);
console.log();
console.log('CURRENT approach sends signal index on every round.');
console.log('MINIMAL approach drops signal index from Round 2+ (LLM already retrieved what it needs).');
console.log();
console.log(`Savings per extra round: ~${indexBytes.toLocaleString()} bytes (~${Math.round(indexBytes / 4)} tokens)`);
console.log();
console.log('With N signals, the index grows linearly. With 20 signals at ~300 chars each:');
const bigIndexSize = 20 * 300;
console.log(`  Index would be ~${bigIndexSize.toLocaleString()} bytes (~${Math.round(bigIndexSize / 4)} tokens) wasted on Round 2+`);
console.log();
console.log('='.repeat(80));
console.log('PROTOTYPE COMPLETE — answer: MINIMAL approach saves signal index bytes on rounds 2+');
console.log('='.repeat(80));