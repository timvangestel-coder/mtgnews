# Issue #172 — Qwen XML Tool Calls Leak as Raw Content

## Prerequisites

- **LM Studio** running locally with a Qwen model loaded (e.g. `qwen/qwen3.6-27b` or `QWEN3.7 27B Q6 MTP`)
- OpenAI-compatible endpoint at `http://127.0.0.1:1234/v1/chat/completions`
- The `mtgnews` project with AgentChat enabled (signal chat scope)

## Background

Qwen models running via LM Studio return tool calls as **XML text in `delta.content`**, not as structured `delta.tool_calls`. The streaming parser in `callLlmStreamWithTools()` detects these XML blocks, parses them into structured `ToolCall` objects, executes the tools, and feeds the results back to the LLM for a final answer.

### Qwen XML Formats observed in practice

**Format A (original — from earlier model versions):**
```xml
<tool_code>
<parameter_code>get_compact_text</parameter_code>
<parameter_code>{"video_id":"RPEzKMfsJvg"}</parameter_code>
</tool_code>
```

**Format B (current live output — anthropic-style tool use):**
```
<tool_call> <function=get_compact_text> <parameter=videoIds> ["SG3tuA8zqs8"] </parameter> </function> </tool_call>
```

## Bugs Fixed

### Bug 1: Agent loop ignored conversation history (`src/services/chat-manager.ts`)

**Problem:** `_runAgentLoop()` always sent the original `agentPrompt` string to the LLM instead of the accumulated `messages[0].content`. Tool results were stored but never re-sent, causing the LLM to call the same tool every round until max rounds expired.

**Fix:** Line 407 changed from `agentPrompt` to `messages[0].content` so tool results are fed back to the LLM on subsequent rounds.

### Bug 2: XML parser only handled Format A (`src/llm.ts` — `parseQwenXmlToolCalls()`)

**Problem:** The Qwen model via LM Studio outputs tool calls as Format B (`<function=name> <parameter=key> value </parameter></function>`), but the parser only recognized Format A. Result: 0 tool calls detected, raw XML leaked through to UI.

**Fix:** Extended `parseQwenXmlToolCalls()` to handle both formats. Updated the detection trigger in `callLlmStreamWithTools()` to check for `</function> + _` in addition to `</tool_code>`. Parameter values are JSON-parsed before storing.

### Bug 3: Recursive nesting in conversation history (`src/services/chat-manager.ts`) — June 19, 2026

**Problem:** The string-based history accumulation in `_runAgentLoop()` created recursive nesting. Each round serialized the entire `messages[]` array (including the user message which already contained prior history) into a new prompt:

- **Round 1:** ~2 KB (`agentPrompt`)
- **Round 2:** ~12 KB (`agentPrompt` + "User: {agentPrompt}" + tool results)
- **Round 3:** ~20+ KB (entire Round 2 prompt re-embedded inside "User:" again)

**Fix:** Introduced `ConversationState` module (`src/chat-conversation-state.ts`) with a deep interface (`addTurn`, `buildPrompt`). The module maintains turns as a flat list so `buildPrompt(base)` always returns `base + serialized turns` — the base prompt appears exactly once regardless of round count. No recursive nesting possible by design.

## How to Verify the Fix

### Scenario A: End-to-end via Chat UI (manual)

1. Start the app: `npm start`
2. Navigate to a signal detail page that has `compact_text` populated
3. In the chat panel, ask: `"Can you tell me what happens exactly between minute 8 and minute 10?"`

**Expected:** The LLM calls `get_compact_text`, retrieves compact_text data, then generates a natural language answer in round 2 — no raw XML visible.

### Scenario B: Unit tests (automated)

```bash
npx vitest run src/llm-qwen-xml.test.ts
```

**Expected:** All 9 tests pass (6 Format A + 3 Format B).

### Scenario C: Full regression suite

```bash
npx vitest run src/llm-qwen-xml.test.ts src/issue-170.test.ts src/issue-165.test.ts src/chat-manager-abort.test.ts src/chat-manager-streaming.test.ts src/chat-conversation-state.test.ts
```

**Expected:** All 36 tests pass across 6 test files.

## Verification Checklist

- [x] `callLlmStreamWithTools()` produces populated `toolCalls` array when LLM returns Qwen XML in content (both Format A and B)
- [x] AgentChat tool calling works end-to-end: question → tool call executes → compact_text retrieved → answer persisted (no raw XML in UI)
- [x] Unit tests pass for parser with fragmented tokens (simulating real SSE chunk boundaries) — 9/9
- [x] Existing non-tool-call streaming (plain content) unchanged — no regression
- [x] ConversationState prevents recursive nesting — base prompt appears exactly once per round
- [x] Full related test suite passes — 36/36 across 6 files

## Multi-signal compact_text attribution

`executeGetCompactText()` returns `{videoId, title, content}` per signal in its JSON results. The LLM receives explicit video IDs with each compact_text block, so it can correctly attribute findings to specific videos in the answer. Structure already supports multi-signal disambiguation — not a missing feature.

## Files Changed

| File | Change |
|------|--------|
| `src/services/chat-manager.ts` | Bug 1 fix: `agentPrompt` → `messages[0].content`. Bug 3 fix: Replaced inline `messages[]` with `ConversationState` module. |
| `src/llm.ts` | Bug 2 fix: `parseQwenXmlToolCalls()` handles Format A + Format B. Detection trigger checks for `</function>` too. |
| `src/chat-conversation-state.ts` | New module: `ConversationState` with flat turn list, deep interface (`addTurn`, `buildPrompt`). |
| `src/chat-conversation-state.test.ts` | 6 tests including nesting guard verifying base prompt appears exactly once. |
| `src/llm-qwen-xml.test.ts` | Added 3 Format B test cases (basic parse, reasoning text prefix, retrieving phase). |