# 0003 — Use LLM for Content Relevance Filtering

**Date:** 2026-05-25  
**Status:** Accepted  

## Problem
Signal `z3l1ybLWhko` (a Pokemon TCG video) was processed by the LLM with an MTG-focused prompt (`You are an MTG analyst`). The LLM hallucinated MTG entities ("Aetherdrift", "Paradox Rift") not present in the transcription, mapping ambiguous TCG terms to known MTG concepts from its training data. This produced garbage summaries for non-MTG content that entered the system because channels had no topic filter.

Root cause: no relevance gate before forcing domain interpretation on arbitrary content.

## Decision
Add per-channel free-text `filter_criteria` + LLM-based relevancy check within the existing single merged LLM call.

### Schema changes
- `channels` table: add `filter_criteria TEXT` column (default: "Content must be primarily about Magic: The Gathering (MTG), not other TCGs or unrelated topics.")
- `signals` table: add `relevance_status TEXT` column (`NULL`, `'relevant'`, `'irrelevant'`)

### LLM prompt change
- Pass channel's `filter_criteria` text into the merged prompt
- Add `"relevant": boolean` to JSON response structure
- If `relevant === false`: set `relevance_status = 'irrelevant'`, skip storing summary/sentiment/entities, mark `processed_at` to prevent re-processing
- If `relevant === true` (or missing for backward compat): existing behavior + set `relevance_status = 'relevant'`

### UI changes
- **Admin:** per-channel filter criteria input on add form + editable inline per channel row
- **Signal Viewer:** "Show Irrelevant" toggle button (top right, aligned with channel pills), OFF by default. When ON: include irrelevant signals with dimmed styling (`opacity-50`) + `[Irrelevant]` badge

## Consequences
- **Positive:** Prevents hallucinated summaries for off-topic content. Saves tokens on full analysis for clearly irrelevant signals (LLM returns early). Per-channel flexibility allows multi-topic watchlists later.
- **Negative:** Adds one LLM call dependency to relevance decision (model must be running). Relevance judgment is soft (LLM opinion, not deterministic rule).
- **Reversibility:** Schema changes are additive (columns can be dropped). Prompt change is backward-compatible (`relevant` field absence = treat as relevant).

## Alternatives Considered
1. **Two-phase approach** — separate cheap relevance check first, then full analysis only if relevant. Rejected: user preferred single-call design to keep pipeline simple.
2. **Keyword-based pre-filter** — deterministic string matching before LLM. Rejected: too brittle (misses context, false positives/negatives).
3. **Global filter setting** — one criteria for all channels. Rejected: user wanted per-channel flexibility for future multi-topic use cases.