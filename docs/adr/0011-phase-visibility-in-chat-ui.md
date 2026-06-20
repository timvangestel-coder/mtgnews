# ADR-0011: Phase Visibility in Chat UI

**Date:** 2026-06-19
**Status:** Accepted
**Supersedes:** N/A (new architecture)

## Problem

When a user submits a chat question, the system processes it through multiple LLM phases (`intake` → `reasoning`/`answering`/`retrieving` → `done`) with token counts tracked internally via PhaseRegistry. These phase transitions are invisible to users — they see either "processing..." or the final answer, never the intermediate state changes.

The root cause: phases fire in rapid synchronous bursts during agent loop rounds. The browser never gets a repaint opportunity between them because `onPhaseChange` callbacks execute synchronously without yielding to the event loop. Users observe only the final phase state.

## Context

Phase tracking infrastructure already exists:
- **PhaseRegistry** (`src/phase-registry.ts`) — generic `Map<K, { phase: LlmPhase, tokenCount: number }>` instantiated per consumer
- **ChatQueue._phaseRegistry** — `PhaseRegistry<number>` keyed by question id, written via `onPhaseChange` callback during `chatManager.process()`
- **PHASE_BATCH_SIZE = 10** — currently yields to event loop every 10 phase callbacks via `setTimeout(() => {}, 0)` in ChatQueue._dispatchProcess
- **_chatAnswerStatus.ejs** — template renders phase labels and token counts with `data-chat-phase` / `data-chat-token-count` attributes
- **/chat/:id/status** route — passes `phase` and `tokenCount` to template when status is 'pending'

The poll run progress widget (`views/admin/_pollProgress.ejs`) already displays per-signal phase data (lines 62-91) using an identical phase→label+color mapping. Both systems share the same PhaseRegistry pattern but differ in visibility requirements:
- Poll run: phases are polled from DB after signal completion — no real-time visibility needed during processing
- Chat: phases must be visible DURING processing via 3-second polling interval

## Decision

### 1. Extract shared phase display module

Create `views/scripts/phase-display.js` following the ScopeSource/TimestampNav pattern — a framework-agnostic JS module with pure functions for phase label and color resolution, loaded as `window.PhaseDisplay`.

```javascript
// views/scripts/phase-display.js
const PHASE_LABELS = {
  intake: 'Intaking',
  reasoning: 'Reasoning',
  answering: 'Answering',
  retrieving: 'Retrieving context',
  done: 'Done',
};

const PHASE_COLORS = {
  intake: 'text-gray-500',
  reasoning: 'text-blue-600',
  answering: 'text-purple-600',
  retrieving: 'text-amber-600',
  done: 'text-green-600',
};

function getPhaseDisplay(phase, tokenCount) {
  return {
    label: PHASE_LABELS[phase] || phase,
    color: PHASE_COLORS[phase] || 'text-gray-500',
    tokenLabel: tokenCount != null ? ` (${tokenCount} tok)` : '',
  };
}

if (typeof window !== 'undefined') {
  window.PhaseDisplay = { getPhaseDisplay, PHASE_LABELS, PHASE_COLORS };
}
```

Both `_chatAnswerStatus.ejs` and `_pollProgress.ejs` consume this module instead of maintaining parallel mapping logic.

### 2. Extend onPhaseChange callback with round metadata

Extend the `onPhaseChange` callback signature in ChatManager's process options to include an optional round number:

```typescript
interface ProcessOptions {
  abortSignal?: AbortSignal;
  onPhaseChange: (phase: LlmPhase, tokenCount: number, round?: number) => void;
  onToken: (token: string) => void;
}
```

ChatManager's `_runAgentLoop()` already tracks round count (`let round = 1; while (round <= MAX_ROUNDS)`). It passes `round` through to each phase callback during that iteration. PollRunManager is unaffected — its `onPhaseChange` callback does not use the optional 3rd parameter.

PhaseEntry in PhaseRegistry extended:

```typescript
export interface PhaseEntry {
  phase: LlmPhase;
  tokenCount: number;
  round?: number;  // present for agent chat, absent for poll analysis
}
```

### 3. Yield to event loop after every phase change

Remove `PHASE_BATCH_SIZE` constant and replace with `queueMicrotask()` after every `onPhaseChange`:

```typescript
// In ChatQueue._dispatchProcess
onPhaseChange: (phase: LlmPhase, tokenCount: number) => {
  this._phaseRegistry.set(id, phase, tokenCount);
  queueMicrotask(() => {}); // yield immediately
},
```

`queueMicrotask()` has ~0ms overhead vs ~4ms for `setTimeout`. Microtasks run before the next macrotask, giving the browser maximum opportunity to process paint events between phase updates. The 3-second polling interval provides natural throttling regardless.

### 4. Fade transition on phase text change

Add CSS opacity transition (150ms) triggered by a class swap on phase label changes. The existing `animate-pulse` continues during active processing, signaling "work in progress." The fade triggers only on phase label changes, signaling "state updated." They serve different purposes and coexist.

```css
.chat-phase-text {
  transition: opacity 0.15s ease;
}
.chat-phase-text.phase-changing {
  opacity: 0.3;
}
```

## Consequences

### Positive
- **Users see intermediate states** — phase transitions become visible as the LLM processes each question, building trust in answer quality
- **Single source of truth for phase display** — extracting `phase-display.js` eliminates template duplication and ensures consistency across chat and poll UIs
- **Round indicators enable multi-round transparency** — users see "Round 2/3 — Retrieving context..." which clarifies why processing takes longer than expected
- **Microtask yields are lowest-latency** — no timer overhead, browser gets maximum repaint opportunities during synchronous callback bursts
- **Fade transitions feel professional** — subtle opacity change communicates state update without competing with the pulse "processing" indicator

### Negative
- **More registry snapshots visible to in-flight polls** — each microtask yield makes a new PhaseRegistry entry observable. Mitigated by 3s polling interval which naturally throttles responses.
- **ChatManager owns round state** — extending the callback seam means ChatManager's process interface exposes agent-loop internals. This is acceptable because ChatManager already orchestrates the agent loop and round tracking is a first-class concept.
- **New JS module in views/scripts/** — adds one more client-side script to load before Alpine. Follows established pattern (ScopeSource, TimestampNav) so this is not novel overhead.

### Neutral
- **PhaseEntry.round is optional** — poll analysis paths won't set it, keeping backward compatibility with existing PhaseRegistry consumers

## Alternatives Considered and Rejected

1. **Keep PHASE_BATCH_SIZE at 1 with setTimeout** — Same correctness as queueMicrotask but ~4ms overhead per yield (timer resolution). Rejected because microtasks are lower-latency and the constant adds unnecessary indirection.

2. **Track rounds via separate ChatQueue method instead of callback extension** — Would add `setRound(id, round)` to ChatQueue, coupling it to agent-loop internals. Rejected because the callback seam already exists and extending it keeps round state co-located with phase state at the call site.

3. **CSS color transition via CSS variables** — Could use `--phase-color` CSS variable for smooth color transitions instead of class swaps. Rejected because Tailwind's utility classes are simpler to maintain, and the color change is already visible via the existing class swap mechanism. The fade opacity adds complementary motion feedback that color transition alone wouldn't provide.

4. **Flash/highlight effect on phase change** — A brief highlight implies "something just happened." Phase transitions represent ongoing work, not discrete events. Rejected because a subtle fade better communicates "still processing, state updated" vs "action completed."

## Issues

Implementation tracked in issue #173.