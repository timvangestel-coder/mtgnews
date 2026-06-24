# ADR-0014: Manual Irrelevant Toggle on Signal Detail Header

**Date:** 2026-06-24  
**Status:** Accepted  
**Context:** Add a user-facing toggle button to mark signals as irrelevant directly from the Signal Detail page header, matching the existing "Mark as Reviewed" pattern.

## Problem

Users currently have no manual way to mark a signal as irrelevant from the UI. The `irrelevant` processing_state is only set automatically by the LLM during analysis. When the LLM incorrectly marks a signal as relevant (or vice versa), there's no correction mechanism.

## Decision

Add two toggle buttons to the Signal Detail page toggle bar (the row with Summary/Transcript/Split pills):

1. **"Mark as Irrelevant" / "Irrelevant ✗"** — toggles `processing_state` between `{pending|summarized}` ↔ `irrelevant`
2. **"Mark as Reviewed" / "Reviewed ✓"** — moved from header metadata bar to toggle bar for consistency

### Button Design
- Same pill style as Summary/Transcript/Split toggle buttons (`px-4 py-2 rounded font-medium text-sm transition-colors`)
- **Irrelevant button:** gray when relevant (`bg-gray-200 text-gray-700`), red when irrelevant (`bg-red-600 text-white`)
- **Reviewed button:** purple when unreviewed (`bg-purple-600 text-white`), gray when reviewed (`bg-gray-200 text-gray-700`)
- Both use HTMX `outerHTML` swap for self-updating toggle behavior (same pattern as current Reviewed button)

### Placement
Buttons placed between the Split view toggle and the Summarize button in the toggle bar:
```
[Summary] [Transcript] [Split] [Mark as Irrelevant] [Mark as Reviewed]          [Summarize]
```

### State Transition Logic
- **Relevant → Irrelevant:** Set `processing_state = 'irrelevant'` (existing `markIrrelevant()` function)
- **Irrelevant → Relevant:** Check if `summary IS NOT NULL`:
  - If summary exists → `processing_state = 'summarized'`
  - If no summary → `processing_state = 'pending'`

This preserves the semantic meaning of processing_state: a signal with a summary is "summarized" regardless of how it got there.

### Backend Changes
1. New route: `POST /signals/:id/irrelevant` in `signals-router.ts`
2. New service method: `setIrrelevant(videoId, irrelevant: boolean)` in `SignalQueryService`
3. New state function: `markRelevant(db, videoId)` in `signal-state.ts` — implements the summary-aware transition logic
4. Reuse existing `markIrrelevant()` for the forward direction

## Consequences
- **Positive:** Users can correct LLM relevance decisions manually
- **Positive:** Consistent UI pattern with Reviewed toggle
- **Risk:** Transitioning from irrelevant → pending means re-summarization is possible via the Summarize button, which is the desired behavior
- **Note:** The `getSignalById()` query already selects `processing_state` and `summary`, so no DB schema changes needed