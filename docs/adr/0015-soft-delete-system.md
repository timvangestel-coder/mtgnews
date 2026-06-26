# ADR-0015: Soft Delete System

**Date:** 2026-06-24  
**Status:** Proposed  
**Issues:** #185, #186, #187, #188, #190

## Context

The application currently uses hard deletes for channels (and cascading deletes for signals, entity_mentions). This permanently destroys data with no recovery path. Users have no visibility into what will be deleted before confirming. The current `removeChannel()` function attempts manual cascade deletion but is incomplete — it misses `signal_chat` and `poll_run_progress` rows.

## Decision

Implement a soft-delete system using `deleted_at INTEGER DEFAULT NULL` columns across all user-data tables. Soft deletion sets `deleted_at = Date.now()` instead of removing rows. All read queries filter out soft-deleted rows using inline `AND x.deleted_at IS NULL`.

### Tables requiring `deleted_at`

| Table | Reason |
|-------|--------|
| `channels` | Primary deletion target |
| `signals` | Cascaded from channel delete |
| `entity_mentions` | Cascaded from signal delete |
| `signal_chat` | Cascaded from signal delete + list-scoped chat with matching channel_id |
| `poll_run_progress` | Orphan prevention — progress rows for deleted channels must also be hidden |

> **Grill finding:** `poll_run_progress.channel_id` references channels but has NO FK constraint. Historical progress rows for soft-deleted channels must also be soft-deleted (user decision). This requires `deleted_at` on `poll_run_progress`, which was missing from the original #185 scope.

### Filtering Approach: SoftDeleteFilter Module (REVERSED from inline)

**Original decision (2026-06-24):** Inline filtering was chosen over a helper function.

**Reversed (2026-06-25 architecture review):** The "27 is small enough" argument confuses code size with risk surface — 27 query sites across 10 files means 27 independent leak points where soft-deleted data silently appears. A dedicated `SoftDeleteFilter` module eliminates this entire class of bugs.

Module: `src/db/soft-delete-filter.ts`
```typescript
export function softDeleteFilter(alias?: string): string {
  return alias ? `AND ${alias}.deleted_at IS NULL` : 'AND deleted_at IS NULL';
}
```
- Alias parameter ensures correctness in JOIN queries (no missing prefix bugs)
- Pure function, minimal test file (`soft-delete-filter.test.ts`, 2 tests)
- All 27 call sites use `softDeleteFilter('c')` instead of inline string literals

### Cascade Semantics (Soft Delete — UPDATE)

Top-down, parent-first when soft-deleting a channel:
```
channels → signals → entity_mentions → signal_chat → poll_run_progress
```

**signal_chat cascade scope:** Both per-signal chats (`signal_video_id IN (...)`) AND list-scoped chats with matching `channel_id` are cascade-deleted. This decision was made in earlier issues and is recorded in the CONTEXT.md glossary (SoftDelete term).

**poll_run_progress cascade:** All progress rows referencing the deleted channel get `deleted_at` set, regardless of status. No 'skipped' status needed — soft-deleted rows are simply filtered out by `AND deleted_at IS NULL`, so they no longer appear in the UI.

### Purge Order (Hard DELETE)

Bottom-up, children-first (required by FK RESTRICT):
```
poll_run_progress → signal_chat → entity_mentions → signals → channels
```

FK chain (no CASCADE defined, SQLite defaults to RESTRICT):
- `signals.channel_id` → `channels(channel_id)`
- `entity_mentions.signal_video_id` → `signals(video_id)`
- `signal_chat.signal_video_id` → `signals(video_id)` (nullable)

### Undo Semantics

`undoAllSoftDeletes()` (#190) resets ALL `deleted_at` to NULL across all 5 tables in one transaction. This resurrects channels, signals, mentions, chats, AND progress rows. Order doesn't matter for undo (setting `deleted_at = NULL` can't create FK violations).

> **Risk:** Undoing a soft-deleted channel during an active poll could cause the poll worker to re-process that channel if the resurrected progress row is picked up. Explicit handling needed: check for active poll before undo, or exclude in-progress runs from undo scope. Tracked in #191.

## DB Function Signatures (refined during #190 grill)

```typescript
// src/db/watchlist.ts

interface SoftDeleteCounts { channels: number; signals: number; mentions: number; chats: number; }
interface UndoResult extends SoftDeleteCounts { total: number; }

// Database-wide counts (#190) — no channelId, scans all tables
function getDbWideSoftDeleteCounts(db): SoftDeleteCounts;
function undoAllSoftDeletes(db): UndoResult;
function purgeAllSoftDeleted(db): UndoResult;

// Per-channel counts (#186) — scoped to one channel's cascade
// Named getChannelSoftDeleteCounts to distinguish from getDbWideSoftDeleteCounts.
```

### Return shape decisions (grill Q1-Q3) — REVERSED on progress exclusion
**Original decision:** Progress rows excluded from all count/undo/purge responses.

**Reversed (2026-06-25 architecture review):** User changed mind — progress counts shown everywhere for full transparency. All three functions now include `progress: number`.

```typescript
interface SoftDeleteCounts { channels: number; signals: number; mentions: number; chats: number; progress: number; }
interface UndoResult extends SoftDeleteCounts { total: number; }
```

- `undoAllSoftDeletes` returns `{ channels, signals, mentions, chats, progress, total }`
- `purgeAllSoftDeleted` returns same shape — includes progress count
- `getDbWideSoftDeleteCounts` returns `{ channels, signals, mentions, chats, progress }` — 5 tables

## Grilling Decisions (2026-06-24)

### Signal Chat Scope — OR Condition Confirmed
List-scoped chat rows where `channel_id` matches the deleted channel ARE cascade-deleted via the OR condition. No risk of cross-channel scope leakage since list-scoped chat with a specific `channel_id` targets only that one channel's signals.

### Counts Accuracy — Separate Functions
Count functions and delete functions remain separate. Developer maintains WHERE clause consistency manually. Simpler interface, no dryRun flag complexity.

### Single Timestamp
One `Date.now()` call at function entry. All cascaded entities (channel + signals + mentions + chats) share the identical `deleted_at` value, grouping "one user action" in audit trails.

### deleted_at Type — INTEGER Everywhere
Consistent `INTEGER` type across all 5 tables using `Date.now()` (epoch ms). Does NOT match per-table convention (signal_chat.created_at uses TEXT ISO). Consistency wins over per-table parity.

### Old removeChannel() — Replaced, Not Preserved
The DB-level hard-delete cascade at watchlist.ts:109 is overwritten by `softDeleteChannel()`. No rename to `hardDeleteChannel()` since purge-all (#190) uses `WHERE deleted_at IS NOT NULL` pattern, not cascade. Service-layer `removeChannel()` stays but calls `softDeleteChannel()` internally.

### activeFilter Helper — Rejected, then Reopened
The `activeFilter(tableName)` helper was initially rejected as too shallow (2026-06-24 grill). However, the architecture review (2026-06-25) reopened this: a focused `SoftDeleteFilter` module passes the deletion test — deleting it concentrates leak risk into zero, proving the module adds real depth. The original rejection reason was that the helper was proposed as a generic active-state filter; a domain-specific soft-delete filter is different and justified.

## Grilling Decisions — Issue #190: Undo All + Purge All Endpoints with Data Tab (2026-06-25)

### Q1-Q3: Return shapes — Per-table breakdown excluding progress
All count/undo/purge functions return per-table breakdowns. Progress rows are excluded from responses (internal only). The 4-user-visible-table pattern is consistent across all endpoints.

### Q4: Post-action feedback — HTMX inline update, no reload
After undo/purge confirmation, the POST endpoint returns fresh fragment HTML which HTMX swaps into place via `hx-swap="outerHTML"`. No full page redirect. Single HTTP round-trip.

### Q5: Data tab as EJS partial — _dataTab.ejs + dedicated fragment endpoint
Extracted to `views/admin/_dataTab.ejs` rendered by `GET /admin/data-fragment`. The admin router's `GET /admin` includes it via `<%- include('admin/_dataTab') %>`. After undo/purge, the POST endpoints render this same partial for HTMX swap.

### Q6: Data tab auto-refresh — No polling
Counts load once when the Data tab is selected (server-rendered). After undo/purge, HTMX swaps fragment with fresh counts. No `hx-trigger="every Ns"` polling.

### Q7: Undo/Purge button disabled state — Disabled when count is zero
Buttons rendered with `disabled` attribute when total soft-delete count is 0. Prevents accidental no-op clicks.

### Q8: Initial Data tab count loading — Server-rendered via GET /admin locals
Counts passed to `res.render('admin', { softDeleteCounts })`. Zero extra HTTP requests on page load.

### Q9: Modal trigger — Embed counts inline, skip fetch
Buttons dispatch `open-delete-modal.window` with counts embedded in the event payload (no extra fetch). The modal supports both modes: "counts provided" (skip fetch) and "countsUrl provided" (fetch first). Channel delete (#187) uses countsUrl; Undo/Purge embed counts.

### Q10: HTMX fragment swap — Single POST returns fresh fragment
POST to `/admin/undo-all` or `/admin/purge-all` renders `_dataTab.ejs` with fresh counts, returned as response body. HTMX swaps via `hx-target="#data-tab-content" hx-swap="outerHTML"`. One round-trip, atomic update.

## Grilling Decisions — Issue #187: Delete Confirmation Modal (2026-06-24)

### Q1: Modal Technology — Reusable UI Fragment + Service Layer
- Alpine.js component extracted to `views/scripts/admin-delete-modal.js`
- The "entity counts display" is a standalone EJS partial (e.g., `views/admin/_entityCounts.ejs`) accepting a `{ counts }` object
- Channel delete (#187) fetches per-channel counts; Undo/Purge (#190) shows database-wide counts
- Modal wrapper handles overlay + Cancel/Delete buttons; callers inject the counts fragment

### Q2: Trigger Flow — Alpine Owns Full Flow (Approach A)
- Replace `<form hx-post="/admin/channels/remove">` with plain `<button @click="...">`
- Alpine handles: dispatch custom event → modal fetches counts → shows modal → user confirms → Alpine POSTs via fetch() → page reload
- No HTMX involved in the delete flow. Avoids race conditions between async count fetch and hx-confirm

### Q3: Loading State — Silent Fetch, No Indicator
- Click Remove → silent fetch (~100-300ms) → modal appears with counts
- No spinner, no button text change. Keep it simple.

### Q4: Visual Design — All Count Lines Always Shown
- Full-screen overlay: `bg-black/50` backdrop + centered card (`bg-white rounded-lg shadow-xl max-w-md`)
- Cancel: `bg-gray-200 text-gray-700`; Delete: `bg-red-600 text-white hover:bg-red-700`
- Close on backdrop click and Escape key
- Always show all count lines (signals, entity mentions, signal chats), even if zero

### Q5: DOM Placement — Top-Level Modal + Custom Events
- Single `<div x-data="deleteModal()">` at top level of admin.ejs, outside tab templates
- Buttons dispatch `open-delete-modal.window` custom events with payload: `{ title, message, countsUrl?, actionUrl, actionPayload?, counts? }`
- Reusable from any tab (Channels now, Data tab in #190 later)

### Q6: Error Handling — Inline Error + Debounce
- If counts fetch fails: modal opens with error message + Close button only (no Delete available)
- Remove button debounced via `:disabled="busy"` Alpine state during fetch

## Complete Query Audit Checklist (#188)

All SELECT queries reading target tables must filter `deleted_at IS NULL`. This list covers production code across ALL modules (not just `src/db/`):

### src/db/watchlist.ts (6 queries)
- [ ] `getChannelsWithTopics()` — channels + topics JOIN
- [ ] `listActiveChannels()` — channels + topics JOIN
- [ ] `getAdminData()` channels query — channels + topics + poll_run_progress JOIN
- [ ] `getAdminData()` topics query — topics LEFT JOIN channels (channels needs filter)
- [ ] `removeChannel()` → will become `softDeleteChannel()` — signals subquery
- [ ] `listChannels()` — channels

### src/db/poll-runs.ts (4 queries, owned by #186)
- [x] `preRegisterChannelProgress()` — handled by #186
- [x] `queryPollRunProgress()` — handled by #186
- [x] `getPollRunById()` subqueries — handled by #186
- [x] `queryPollRuns()` subqueries — handled by #186

### src/query.ts (4 queries)
- [ ] `querySignals()` topicKey subquery — channels
- [ ] `querySignals()` entityMention subquery — entity_mentions
- [ ] `querySignals()` main query + signal_chat correlated subqueries — signals, signal_chat
- [ ] `getEntityTrending()` — entity_mentions JOIN signals

### src/signal-detail.ts (1 query)
- [ ] `getSignalById()` — signals

### src/services/chat-manager.ts (6+ queries)
- [ ] `executeGetCompactText()` — signals
- [ ] `resolveSignalForChat()` — signals LEFT JOIN channels LEFT JOIN topics
- [ ] `getHistory()` legacy path — signal_chat
- [ ] `getHistory()` ChatScope path — signal_chat
- [ ] `process()` — signal_chat WHERE id=?
- [ ] `_processSingleSignal()` history fetch — signal_chat

### src/services/signal-query-service.ts (1 query)
- [ ] `summarizeSignal()` existence check — signals

### src/services/topic-manager.ts (2 queries)
- [ ] Channel count check — channels WHERE topic_id=?
- [ ] Topic list with channel_count — topics LEFT JOIN channels

### src/signal-chat-scope.ts (4 queries)
- [ ] `resolveIndexScope({ videoId })` — signals JOIN channels LEFT JOIN topics
- [ ] `resolveIndexScope(scope)` topic/channel path — signals JOIN channels LEFT JOIN topics
- [ ] `resolveScope()` single signal — signals
- [ ] `resolveScope()` multi-signal — signals JOIN channels LEFT JOIN topics

### src/rss-discovery.ts (1 query)
- [ ] Existing signal check — signals SELECT video_id

### src/poll.ts (1 query)
- [ ] Signal existence check — signals WHERE video_id=?

**Total: ~23 production queries in #188 + 4 in #186 = ~27 across all modules.**

> **PATTERN FOR FUTURE TABLES:** Any new table storing user-visible data MUST include `deleted_at INTEGER DEFAULT NULL` and all read queries MUST filter `AND x.deleted_at IS NULL`. See SoftDelete glossary entry in CONTEXT.md.

## Grilling Decisions — Architecture Review (2026-06-25)

### Candidate #1: SoftDeleteFilter Module (Strong)
Extract `src/db/soft-delete-filter.ts` with `softDeleteFilter(alias?) → string`. Reverses the "inline filtering" decision. Rationale: 27 query sites = 27 leak points; one deep module concentrates risk, provides a single test surface. Alias parameter ensures correctness in JOIN queries.

### Candidate #2: CascadeDelete Module (Strong)
Extract `src/db/cascade-delete.ts` with three operations sharing one config array:
```typescript
const SOFT_DELETE_TABLES = ['channels', 'signals', 'entity_mentions', 'signal_chat', 'poll_run_progress'];
// parent-first for soft-delete/undo, reversed for purge (FK RESTRICT)
```
- `softDelete(db, channelId) → CascadeResult` — per-channel cascade UPDATE
- `undoAll(db) → UndoResult` — reset all deleted_at to NULL
- `purgeAll(db) → PurgeResult` — DELETE in child-first order via `.slice().reverse()`
Single source of truth for "which tables have deleted_at". Adding a 6th table = one array edit.

### Candidate #3: DeleteModal Component (Worth exploring)
Reusable Alpine.js component at `views/scripts/admin-delete-modal.js`. Dual-mode payload: `countsUrl` (fetch before show) or `counts` (inline, skip fetch). Modal handles POST via `fetch()` + page reload. Progress counts visible in all modals (channel delete, undo, purge).

### Candidate #4: DataTab Partial (Speculative)
Extract to `views/admin/_dataTab.ejs`. Wrapper `<div id="data-tab-content">` in admin.ejs; partial is content only. HTMX swap via `hx-target="#data-tab-content" hx-swap="outerHTML"`.

## Consequences

### Positive
- Users can recover accidentally deleted data via "Undo All"
- Confirmation modal shows exact impact counts before deletion
- No FK violations from incomplete cascade logic
- Audit trail: deleted items retain data for potential forensic analysis
- Simpler cascade logic: no need to track DELETE ordering — just UPDATE timestamps

### Negative
- Database grows over time with soft-deleted rows until purged
- Every read query must remember to filter `deleted_at IS NULL` — silent leak risk if forgotten
- 27+ queries across 10 files need modification
- Database-wide undo means one bad undo re-enables everything

### Neutral
- Admin "Data" tab provides visibility into soft-delete counts for manual purge decisions
- Poll run progress for deleted channels is hidden (not a separate 'skipped' state)

## Known Issues
- Edge case: Undo All during active poll — tracked in #191 (Known Edge Cases issue)

## Implementation Notes
- Scope widening required: search ALL `src/db/*.ts` files for queries that could leak soft-deleted data
- Admin UI needs confirmation popup showing counts of affected entities before cascade soft-delete
- Admin UI needs undo button (database-wide reset) and purge button (permanent deletion)
- Poll run handling: set `deleted_at` on poll_run_progress rows, do NOT delete poll_runs or other progress rows. No 'skipped' status — soft-delete + query filtering handles visibility.