# Date Range Filters — Independent Filter Axis

Add preset date range pills (Any time / Last week / Last month / Last year) to the Signal List page. The selected date filter flows through a single `computeDateRange()` function and independently filters both the signals table AND chat scope resolution, ensuring they operate on the same date-filtered signal set.

## Key Decisions

**Independent axis:** Date filtering is an independent dimension, not linked to topic or channel filtering. It follows the same "show-all" pattern: when `date='all'` (or absent), no condition is applied and all rows match on this axis. When a specific preset is selected (`last-week`, `last-month`, `last-year`), only matching rows are returned.

**Preset values stored as-is:** The `signal_chat` table gains a `date_filter TEXT DEFAULT 'all'` column. The preset string (`'last-week'`, `'last-month'`, `'last-year'`, `'all'`) is persisted — not computed ISO bounds. This enables history scoping: each unique `(topicKey, channelId, includeIrrelevant, dateFilter)` composite forms its own conversation.

**Date computation:** `computeDateRange(dateFilter): { from?: string }` is a pure function using JS `new Date()` arithmetic at request time. Maps presets to ISO 8601 lower bounds (e.g., `'last-week'` → `{ from: '2026-06-16T...' }`). Only a `from` bound is set (no `to` — "Last week" means "from 7 days ago until now"). Frozen-at-request-time is acceptable.

**ScopeSource extension:** `dateFilter?: string` added to `ChatScopeData`. The URL param name is `date` (short, not camelCase). `fromCurrentURL()` reads it; `buildHistoryURL()` and `buildAskBody()` include it.

**Signals table path:** Router reads `date` from URL params, calls `computeDateRange()`, passes `{ dateFrom }` to existing `QueryFilters.dateFrom/dateTo` infrastructure in `querySignals()`. No parallel system — the existing filters are activated.

**Chat scope path:** Date bounds reach `resolveScope()` / `resolveIndexScope()` via a separate options parameter: `resolveIndexScope(db, scope, { dateFrom?, dateTo? })`. This keeps `ChatScope` identity-pure (no query-time computed fields in the identity object). The preset string lives in `ChatScope` for persistence; the ISO bounds live in the options param for SQL execution.

**History filtering:** When `date='all'` or absent, no `date_filter` condition is added to `getHistory()` WHERE clause — all list-scoped chats are shown regardless of their stored `date_filter`. When a specific preset is set, only matching rows are returned. Same pattern as topic/channel "show-all" behavior.

## Considered Options
- **SQLite-side date computation** using `datetime('now', '-7 days')` — rejected: harder to unit test as a pure function, and frozen-at-request-time JS dates are acceptable for this use case.
- **Adding dateFrom/dateTo to ChatScope interface** — rejected: keeps identity-pure by passing computed bounds through a separate options parameter.
- **Session-only (no schema change)** — initially proposed but rejected: user wanted full persistence so changing date filter creates a new conversation, consistent with topic/channel behavior.

## Consequences
- `signal_chat` table gains 1 column (`date_filter TEXT DEFAULT 'all'`).
- `resolveScope()` and `resolveIndexScope()` gain an optional second parameter for date bounds.
- `ChatScopeData` in ScopeSource gains `dateFilter?: string`.
- New pure function `computeDateRange()` requires unit tests covering all presets.

**Issues:** #181. https://github.com/timvangestel-coder/mtgnews/issues/181