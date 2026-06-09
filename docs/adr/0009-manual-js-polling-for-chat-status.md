# ADR-0009: Manual JS Polling for Chat Status (replaces HTMX hx-trigger)

**Status:** Accepted  
**Date:** 2026-06-09  
**Context:** Chat panel status polling causes rapid-fire requests when list-scoped chat has many pending messages.

## Problem

HTMX-based status polling (`hx-trigger="every 3s"` on pending answer divs in `_chatHistory.ejs`) caused timer accumulation bugs during outerHTML swaps. When list-scoped chat (no topic/channel filter) had many pending messages, each element created its own HTMX timer that accumulated during DOM replacement via `hx-swap="outerHTML" hx-select=".chat-answer"`. This resulted in rapid-fire status requests (every ~100ms instead of every 3s). The bug only occurred when both topicKey and channelId were empty — with filters applied, fewer messages meant fewer timers and no visible accumulation.

## Decision

Replace HTMX-based polling entirely with manual JavaScript `setInterval` polling in the Alpine component:

- **Removed** all `hx-get`/`hx-trigger="every 3s"` attributes from pending answer divs in `_chatHistory.ejs`
- **Added** `_startStatusPolling()` method that uses clean `setInterval` to poll `/chat/:id/status` every 3 seconds
- **Added** `_stopStatusPolling()` method called on chat close and when all questions complete
- Pending divs are now plain HTML with only `data-chat-status="pending"` and `data-chat-id="<id>"` attributes

### Code Changes

**_chatHistory.ejs:**
```diff
- <div hx-get="/chat/123/status" hx-trigger="every 3s" hx-swap="outerHTML" hx-select=".chat-answer">
+ <div data-chat-status="pending" data-chat-id="123">
```

**chat-panel.js (Alpine component):**
```javascript
_startStatusPolling: function() {
  if (this._statusPollTimer) clearInterval(this._statusPollTimer);
  this._statusPollTimer = setInterval(() => {
    var pendingEls = document.querySelectorAll('[data-chat-status="pending"]');
    if (!pendingEls.length) { clearInterval(...); return; }
    // fetch each pending status, reload history on completion
  }, 3000);
},

_stopStatusPolling: function() {
  if (this._statusPollTimer) {
    clearInterval(this._statusPollTimer);
    this._statusPollTimer = null;
  }
}
```

## Consequences

### Positive
- **Single timer** per chat panel instance, regardless of number of pending messages
- **Clean lifecycle**: timer starts on history load, stops on completion or close
- **No timer accumulation** during DOM swaps — `setInterval` is framework-independent
- **Predictable behavior** across all filter states (no more rapid-fire with no-filter)

### Negative
- **Loss of HTMX declarative syntax**: polling logic is now imperative JS instead of template attributes
- **Status updates require full history reload** on completion (instead of atomic outerHTML swap per answer div)
- **Tighter coupling** between Alpine component and chat status endpoint polling pattern

### Neutral
- Test suite updated: `src/routes/chat-router.polling.test.ts` assertions now verify plain HTML instead of HTMX attributes
- No API contract changes — `/chat/:id/status` still returns same JSON structure

## Alternatives Considered

1. **Keep HTMX, fix timer cleanup**: Attempted by removing `hx-push` and using `hx-swap="none"`, but timer accumulation persisted during outerHTML swaps with multiple pending elements.

2. **Increase poll interval**: Would reduce severity but not eliminate the root cause (timer accumulation).

3. **WebSocket/server-sent events**: Overkill for this use case — polling every 3s is sufficient for a non-real-time chat feature, and adds infrastructure complexity.