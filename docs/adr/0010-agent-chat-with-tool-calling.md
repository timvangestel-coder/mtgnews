# ADR-0010: AgentChat with LLM Tool Calling

**Date:** 2026-06-18
**Status:** Accepted
**Supersedes:** N/A (replaces direct-injection model in ADR-0007)

## Problem

Multi-signal chat sends full `compact_text` for every signal in scope to the LLM in a single prompt. With 20 signals at ~1500 tokens each, this produces ~30K input tokens. The LLM's attention computation scales O(n²), making responses slow and increasingly so with each additional signal. ADR-0003 (CompactTranscription) reduced token count by ~50% compared to full transcriptions, but the all-at-once injection model still suffers from quadratic scaling as signal count grows.

ADR-0003 originally rejected RAG ("overkill for ~20-50 signals per filter"), but observed query latency indicates the threshold has been exceeded.

## Decision

Replace direct-injection with **AgentChat** — a two-step retrieval pattern using LLM-driven tool calling where the model itself decides which `compact_text` to retrieve, rather than pre-selecting via embeddings or sending everything upfront.

### How It Works

1. **Round 1 (Index):** Send signal index (`title + summary` per signal in scope, ~50 tokens/signal) + user question → LLM reads summaries, decides which signals are relevant, calls `get_compact_text(videoIds)` tool
2. **Tool Execution:** Backend executes the tool — an in-process SQLite query fetching `compact_text` for requested videoIds — injects result as `role: "tool"` message back to LLM
3. **Round 2 (Answer):** LLM generates final answer with retrieved compact texts in context
4. Supports up to **3 rounds** (hard cap) if the LLM needs additional signals after reading the first batch

### Applied uniformly to all chat scopes

Both per-signal and multi-signal chat use the same two-step code path. Per-signal already uses `compact_text` (since ADR-0003), so the tool call adds minimal overhead for a single signal while providing architectural uniformity.

### Tool schema

```json
{
  "name": "get_compact_text",
  "parameters": {"videoIds": ["string"]}
}
```

No format parameter (always returns `compact_text`). No cap on videoIds per call — trusts the LLM to request only relevant signals. Implemented as an in-process SQLite query in ChatManager, not an external service.

### Streaming behavior

Retrieval reasoning is streamed to the UI (two-phase visible output) but NOT persisted. Only the final answer goes into `signal_chat.answer`, keeping history lean for future conversation context.

A new `'retrieving'` phase added to LLMPhase: fires when the model calls `get_compact_text`. Retrieval thoughts are yielded during streaming but excluded from the persisted answer.

### Prompt template consolidation

Replaces both `assembleChat()` and `assembleMultiSignalChat()` with a single `assembleAgentChat(indexSignals, question, history)` producing `<signal_index>` XML blocks plus tool instructions. The poll analysis path (`analyzeSignal`) remains unchanged via `assemble()`.

## Consequences

### Positive
- **No external dependencies** — no vector DB, no embedding model, no MCP server needed
- **LLM as relevance filter** — uses the model's own semantic understanding rather than cosine similarity heuristics
- **Uniform code path** — one chat architecture for both scopes instead of two divergent paths
- **Multi-round capability** — LLM can adaptively request more signals if first batch insufficient (capped at 3)
- **Transparent to user** — retrieval reasoning visible via streaming, building trust in answer quality

### Negative
- **Extra HTTP round-trip(s)** — each retrieval round is one additional call to LM Studio. Single-signal chat adds ~200ms overhead vs current direct path (offset by 50% token reduction from compact_text)
- **Tool calling dependency** — requires `qwen/qwen3.6-27b` on LM Studio supports function calling via OpenAI-compatible endpoint
- **Schema change in prompt assembly** — removes two existing functions, adds one new entry point
- **Risk of LLM requesting all signals** — no hard cap per tool call means the model could negate optimization by requesting everything. Mitigated by prompt instruction + trust in model judgment

## Alternatives Considered and Rejected

1. **Embedding-based RAG (chunk-level)** — Split `compact_text` into chunks, embed each via `/v1/embeddings`, ANN search at query time via `sqlite-vec`. Higher retrieval precision but ~50× ingestion cost per signal (one embed per chunk). Also requires dedicated embedding model alongside chat model. Rejected for complexity and ingestion overhead.

2. **Embedding-based RAG (summary-level)** — One embed per signal summary, cheaper than chunk-level but coarser retrieval. Still requires new dependency (`sqlite-vec`) and separate embedding generation path. Rejected because the LLM's own judgment is a better relevance filter than cosine similarity for this domain.

3. **Summary-first with lazy expansion (hybrid, no tool calling)** — Send summaries + question in Round 1 → system pre-selects signals via hardcoded rules → fetches compact_text → Round 2 answer. Simpler than tool calling but less flexible. Rejected because the LLM-driven approach adapts to arbitrary question types without rule engineering.

4. **Hierarchical RAG (summary → compact_text → full transcription)** — Three-level retrieval hierarchy with confidence scoring at each level. Overkill for current scale where `compact_text` already preserves all semantic content. Full transcription is redundant for chat questions. Rejected for unnecessary complexity.

## Issues

Analysis session 2026-06-18. Follow-up implementation issues to be created via `to-issues` skill.