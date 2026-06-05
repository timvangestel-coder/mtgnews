# ADR-0002: Prompt Template Architecture

**Date:** 2026-06-05
**Status:** Proposed
**Supersedes:** N/A (related to ADR-0004: Topic-based Relevance Filtering)

## Context

The LLM prompt for Signal analysis was entirely hardcoded in `prompt-builder.ts` as a single string concatenation function (`buildMergedPrompt`). Every aspect of the prompt — role definition, JSON output schema, entity vocabulary, sentiment scale, and rules — was baked into source code. The only dynamic input per Signal was `filter_text` from the Topic table, resolved via four ad-hoc SQL queries inside `llm.ts`.

This created two problems:

1. **Prompt experimentation required code deploys.** Testing a different prompt style meant editing TypeScript, rebuilding, and restarting the server — an unacceptable friction for prompt engineering iteration.
2. **Shallow modules with leaked complexity.** The `prompt-builder.ts` module was a pass-through (interface nearly as complex as implementation). The `llm.ts` module knew about the channels→topics join chain, leaking database structure across its seam.

Prompt engineering best practices (XML delimiters, role assignment, few-shot examples, output format control) are prompt-level concerns that should be configurable without code changes.

## Decision

Introduce a per-Topic prompt template system with two new deep modules:

### 1. SignalContext (`src/signal-context.ts`)

A context resolution module that performs a single joined query (signals JOIN channels JOIN topics) returning a `SignalContext` object:

```typescript
interface SignalContext {
  transcriptionJson: string;   // raw JSON blob from DB
  topicId: number;
  filterText: string;
  summaryPrompt: string | null; // custom template or NULL for default
}
```

The interface carries raw data — no formatting decisions. This eliminates the four ad-hoc SQL queries in `llm.ts`.

### 2. PromptAssembler (`src/prompt-assembler.ts`)

A prompt rendering module that loads per-Topic XML templates from `topics.summary_prompt` and injects variables into XML placeholder tags:

```typescript
function assemble(context: SignalContext): string;
```

Templates use XML placeholder tags (e.g., `<transcription>`, `<filter_text>`) that the assembler replaces with actual values. When a topic has no custom prompt (`summaryPrompt IS NULL`), the assembler falls back to a compiled default template matching current behavior.

The assembler also formats raw transcription JSON into timestamped text before injection — keeping `SignalContext` as a pure data carrier.

### 3. Database schema change

Add `summary_prompt TEXT` column to `topics` table (nullable). Existing topics continue with the default prompt until a custom template is set.

### 4. Admin UI extension

Add a textarea for prompt template editing in the Admin [Topics] panel (both create form and edit row).

## Consequences

| Positive | Negative |
|----------|----------|
| No-code prompt iteration via Admin UI | One DB migration (ALTER TABLE) |
| Deeper modules — PromptAssembler concentrates all prompt logic | Template injection attack surface (mitigated by whitelisted variable names) |
| SignalContext reusable by any LLM call path | ~174 net new lines of code |
| Tests can mock template store, test rendering in isolation | Existing `prompt-builder.ts` + `llm.ts` must be refactored |
| XML delimiter support aligns with prompt engineering best practices | |

## Alternatives Considered

- **Option B: Consolidated assembler** — DB lookup + rendering in one module. Simpler for callers but loses the ability to test rendering without a DB mock. Less leverage.
- **Option C: Internal refactor only** — No new seam. Lowest risk but doesn't solve the no-code iteration problem.
- **Mustache syntax (`{{variable}}`)** — Simpler but could conflict with LLM reasoning text containing `{{}}`.
- **Formatted transcription in SignalContext** — Traps formatting logic inside context resolver, reducing assembler independence.