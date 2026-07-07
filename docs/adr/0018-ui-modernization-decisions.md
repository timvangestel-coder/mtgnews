# ADR-0018: UI Modernization Architecture Decisions

**Date:** 2026-07-06
**Status:** Accepted
**Context:** UI Design Modernization Review (`%TEMP%/ui-modernization-review-20260706.html`) identified 7 candidates spanning visual design, layout, and interaction patterns. Grilling session resolved 6 design decisions.

---

## Decision 1: Full Candidate Set with Alpine.js Complexity

**Option chosen:** Commit to all 7 candidates (#1–#7), accepting increased Alpine.js complexity over a phased incremental approach.

**Rationale:** The team wants the complete modernization in one pass rather than deferring card layouts, filter bars, and chat polish to a later phase. This means Candidates #3 (Card List), #4 (Filter Bar), #5 (Signal Detail tabs), and #6 (Chat Panel) will be implemented alongside the foundation candidates (#1 Tokens, #2 Sidebar, #7 Typography).

**Consequences:**
- Alpine.js interaction logic grows beyond simple `x-show` toggles
- Requires centralized state management (see Decision 2)
- Higher upfront effort, but avoids a second modernization pass

---

## Decision 2: Extract `ui-state.js` for Centralized Alpine.js Logic

**Option chosen:** Extract Alpine.js data functions into `views/scripts/ui-state.js` rather than keeping `x-data` inline in EJS templates.

**Rationale:** Filter state needs to drive card list filtering across two partials (`signals.ejs` + `_signalsTable.ejs`). Inline `x-data` cannot share state between components. A centralized module exports reusable Alpine.js data functions:
- `signalListView()` — card list state, selection, expansion
- `filterBar()` — topic/date/channel filter state, reads from URL params
- `chatPanel()` — open/close, message history, streaming target
- `detailTabs()` — summary/transcript/split view state

**Consequences:**
- New `.js` file in `views/scripts/` directory (currently pure EJS)
- Templates reference functions: `x-data="filterBar()"` instead of inline objects
- Logic becomes independently testable

---

## Decision 3: Design Tokens via CDN Config (Zero Build)

**Option chosen:** Define semantic color tokens via Tailwind CDN config extracted to `views/scripts/tailwind-config.js`, keeping zero build overhead.

**Token palette:**
| Token | Value | Usage |
|-------|-------|-------|
| `brand` | `#6366f1` (indigo-500) | Primary actions, active states, links |
| `success` | `#10b981` (emerald-500) | Positive sentiment, completed states |
| `warning` | `#f59e0b` (amber-500) | New signals, forced/aborted states |
| `danger` | `#ef4444` (red-500) | Failed states, irrelevant marking |
| `muted` | `#64748b` (slate-500) | Inactive pills, borders, metadata |
| `surface` | `#f8fafc` (slate-50) | Cards, panels, backgrounds |

**Rationale:** The project has no build step. Migrating to Tailwind CLI adds complexity for a 6-token config. Extracted JS file keeps tokens version-controlled and diff-reviewable without touching the build pipeline.

**Consequences:**
- Config loaded via `<script type="module">` before Tailwind CDN script in `layout.ejs`
- New utility classes: `bg-brand-500`, `text-success-600`, etc.
- Future migration to Tailwind CLI possible if plugins needed (forms, typography)

---

## Decision 4: Server-Driven Filtering via HTMX

**Option chosen:** Keep server-driven filtering. Filter changes trigger HTMX requests returning fresh `_signalsTable.ejs` partials. `ui-state.js` only manages visual state (active pill highlighting), reading from `window.location.search`.

**Rationale:** The current query-param routing (`?topic=mtg&date=week`) is clean and consistent. Server-side filtering is the single source of truth. Introducing JSON APIs for client-side filtering breaks existing patterns and adds memory concerns with large signal sets.

**Consequences:**
- Network round-trip on every filter change (acceptable for this scale)
- No new JSON endpoints required
- Alpine.js `filterBar()` function mirrors URL params for visual active-state only
- Pagination handled naturally by server

---

## Decision 5: Signal Detail — x-show Toggle Restyled as Underline Tabs

**Option chosen:** Keep current `x-show` toggle behavior, restyle from pill buttons to underline-style tabs using CSS/token changes only.

**Rationale:** Signal detail is a single-signal page — already fast. All three panels (Summary, Transcript, Split) are rendered server-side on initial load. Lazy-loading via HTMX adds loading states and complexity for no meaningful performance gain. The visual improvement is pure CSS work.

**Consequences:**
- Zero behavior change, instant tab switching
- All three panels always in DOM (acceptable for single-signal scope)
- Tab component lives in `ui-state.js` as `detailTabs()`

---

## Decision 6: Chat — Single Growing AI Bubble for Streaming

**Option chosen:** Create an empty AI bubble immediately on send. Stream tokens into that bubble's inner content element. The bubble grows in real-time.

**Rationale:** Raw-text-then-wrap creates a jarring visual pop. The streaming handler already targets specific DOM elements via HTMX `hx-target`. Changing the target from `<div>` to `<div class="bubble"><span id="stream-target"></span></div>` gives natural typing-within-bubble behavior matching modern chat UX expectations.

**Consequences:**
- Streaming handler targets bubble's inner `<span>` rather than a bare container
- Bubble wrapper created client-side by `chatPanel()` before streaming starts
- Scroll-to-bottom triggered on each token append (Alpine.js watcher)

---

## Files Affected

| File | Candidates | Changes |
|------|-----------|---------|
| `views/scripts/tailwind-config.js` | #1, #7 | **NEW** — Semantic color tokens, type scale |
| `views/scripts/ui-state.js` | #3, #4, #5, #6 | **NEW** — Alpine.js data functions |
| `views/layout.ejs` | #1, #2, #7 | Token config load, sidebar redesign, typography |
| `views/signals.ejs` | #4 | Filter bar → command bar with segmented controls |
| `views/_signalsTable.ejs` | #3 | Table → card list layout |
| `views/signal-detail.ejs` | #5 | Pill toggles → underline tabs, card container |
| `views/_chatPanel.ejs` | #6 | Message bubbles, gradient header, scope badge |
| `views/_chatHistory.ejs` | #6 | Bubble rendering, streaming target |

## Rollout Sequence

1. **Foundation:** Token system (#1) + Typography (#7) → `tailwind-config.js`
2. **Structure:** Sidebar (#2) + Card List (#3) + Filter Bar (#4)
3. **Polish:** Signal Detail tabs (#5) + Chat Panel (#6)