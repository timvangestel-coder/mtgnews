# 0008 — ScopeSource Seam for Chat Scope Data

**Date:** 2026-06-09
**Status:** Accepted
**Supersedes:** Aspects of ADR-0007 (multi-signal-chat) regarding frontend scope state management

## Context

The SignalChat feature on the Signal List page suffered from three interrelated bugs caused by Alpine.js reactive state drifting from the browser URL:

1. **Scope drift:** `chat-panel.js` maintained `this.topicKey`, `this.channelId`, and `savedTopicKey`/`savedChannelId` as Alpine reactive properties. These were only updated when chat was open (`if (!self.chatOpen) return`). When filters changed while chat was closed, the internal state became stale relative to the URL.

2. **Scattered scope logic:** Five methods in `chat-panel.js` each re-implemented URL parsing, params building, and scope normalization. This shallow scatter made bugs hard to locate and fix — changes in one method didn't propagate to others.

3. **No integration test coverage:** The full POST→router→manager→DB→history path was untested. Unit tests mocked ChatManager; E2E tests didn't exist for chat scope. Bugs lived in the gap between these layers.

## Decision

Created a `ScopeSource` deep module providing pure functions for reading and building ChatScope data:

- **`fromCurrentURL()`** — reads browser URL query params, returns normalized `{topicKey?, channelId?, includeIrrelevant}`
- **`buildHistoryURL(scope)`** — constructs `/chat/history?...` with correct params appended
- **`buildAskBody(question, scope)`** — builds POST body for `/chat/ask` with correct scope

All callers in `chat-panel.js` now read scope at point-of-use via `ScopeSource.fromCurrentURL()` instead of maintaining stale Alpine reactive properties. Deleted `_syncScopeFromUrl()`, `savedTopicKey`, `savedChannelId`, and the `this.topicKey`/`this.channelId` reactive props.

Two adapters exist at this seam:
- **TypeScript adapter:** `src/scope-source.ts` — tested via Vitest unit tests (17 tests)
- **Browser adapter:** `views/scripts/scope-source.js` — loaded as `window.ScopeSource` before `chat-panel.js`, tested via Playwright E2E (10 tests)

Integration test coverage added: `src/routes/chat-router-scope-roundtrip.test.ts` (10 supertest tests covering full POST→DB→history path).

## Consequences

**Positive:**
- **Locality:** All scope bugs concentrate in one module. Fix once, fixed everywhere.
- **Leverage:** 5 callers cross one seam instead of each re-implementing URL parsing.
- **Testability:** Pure functions tested in isolation (unit), browser behavior verified (E2E), full path covered (integration).
- **Refactor safety:** Deleted drift-prone Alpine state (`_syncScopeFromUrl`, `savedTopicKey`). No reactive props to go stale.

**Negative / Open Questions:**
- Filter pills use HTMX fragment swaps which may NOT update `window.location.href`. If confirmed, ScopeSource needs a fallback to read from Alpine store state when URL params are absent. This is the single remaining risk — if pills don't update the real URL, `fromCurrentURL()` reads stale values.

**Testing surface:**
- Unit: `src/scope-source.test.ts` (17 tests) — pure function behavior
- E2E: `tests/e2e/chat-scope.spec.ts` (10 tests) — browser module loading, URL reading, output correctness
- Integration: `src/routes/chat-router-scope-roundtrip.test.ts` (10 tests) — full POST→DB→history path