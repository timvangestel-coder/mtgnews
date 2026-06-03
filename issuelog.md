# Issue Log
Last processed: #78 | Generated: 2026-05-30T23:27:00Z | Entries: 25

## Implemented Issues

### #78 — PollRunManager Consolidation
**Area:** poll, orchestration | **Type:** refactor | **Closed:** 2026-05-30
**Status:** ⚠️ Partial (CLOSED, 0/13 checkboxes checked) — ⚠️ Fallback
**What changed:** Consolidated scattered poll run orchestration (`poll-scheduler.ts`, `poll-worker.ts`, `PollTriggerService`) into single deep `PollRunManager` module with `startRun()`, `abortRun()`, `runState()` interface and `RunState` view model.
**Files touched:** `src/poll-run-manager.ts` (new), `src/server.ts`, `src/routes/admin-polling-router.ts`
**Behavioral risk:** HIGH — massive consolidation of three modules into one, full lifecycle ownership
**Key detail:** Acceptance criteria checkboxes all unchecked — implementation may be incomplete. Old files (`poll-scheduler.ts`, `poll-worker.ts`) may not be removed yet.

### #77 — Phase Tracking with Analysis Counter in Progress Widget
**Area:** poll, ui | **Type:** feature | **Closed:** 2026-05-30
**Status:** ⚠️ Partial (CLOSED, 0/10 checkboxes checked) — ⚠️ Fallback
**What changed:** Added `phase` column (`channel_polling`, `analyzing`, `complete`) and `signals_analyzed` counter to `poll_runs` table. Worker writes phase transitions and increments counter after each `analyzeSignal()` call. Progress widget shows "Analyzing signals... 2/5" during Phase 2.
**Files touched:** `src/db/init-db.ts` (schema), `src/poll-worker.ts` (phase writes), views (progress widget)
**Behavioral risk:** MEDIUM — DB schema change + worker state updates + UI display
**Key detail:** Acceptance criteria checkboxes all unchecked — implementation may be incomplete.

### #76 — Instant Progress Widget with Step Pre-Registration
**Area:** poll, ui | **Type:** feature | **Closed:** 2026-05-30
**Status:** ⚠️ Partial (CLOSED, 0/9 checkboxes checked) — ⚠️ Fallback
**What changed:** Replaced redirect-based progress flow with instant inline widget. Step pre-registration inserts `pending` rows in `poll_run_progress` for all active channels before processing starts. Trigger form uses HTMX outerHTML swap instead of HX-Redirect.
**Files touched:** `src/server.ts` (trigger handler), views/admin.ejs, views/_pollProgress.ejs
**Behavioral risk:** MEDIUM — HTMX flow change from redirect to inline widget update
**Key detail:** Acceptance criteria checkboxes all unchecked — implementation may be incomplete.

### #75 — Real-time Poll Progress with PollRunManager Consolidation (Parent Epic)
**Area:** poll, ui | **Type:** feature | **Closed:** 2026-05-30
**Status:** ⚠️ Partial (CLOSED, 9/17 checkboxes checked) — ⚠️ Fallback
**What changed:** Parent epic for real-time progress system: step pre-registration, inline widget update, phase tracking + analysis counter, PollRunManager consolidation. Backend mostly complete but UI layer not fully wired up.
**Files touched:** Many files across src/ and views/ — see child issues #76-#78
**Behavioral risk:** HIGH — umbrella issue for major poll progress overhaul
**Key detail:** Diagnosis notes: backend `runState()` builds correct view model, but routes/templates bypass it using raw DB queries. Progress widget doesn't display phase + analysis counter. Channel status colors wrong.

### #74 — Transcription Merge Module Extraction
**Area:** transcription | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ No criteria (CLOSED, no checkboxes in final state)
**What changed:** Extracted `mergeOverlappingSegments()` and `groupSegments()` from `transcription.ts` into new `transcription-merge.ts`. Pure-function module with zero I/O.
**Files touched:** `src/transcription-merge.ts` (new), `src/transcription.ts` (imports updated), `src/merge-segments.test.ts` (import path)
**Behavioral risk:** LOW — pure extraction, no behavioral change verified by tests
**Key detail:** Output format unchanged. Same merge algorithm, different file location.

### #73 — HTTP Retry Module Extraction
**Area:** http, llm | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ No criteria (CLOSED, no checkboxes in final state)
**What changed:** Extracted generic `fetchWithRetry()` from `llm.ts` into standalone `http-retry.ts`. Consumer-agnostic module with timeout, abort signaling, transient error detection, and exponential backoff.
**Files touched:** `src/http-retry.ts` (new), `src/http-retry.test.ts` (new), `src/llm.ts` (updated to use fetchWithRetry)
**Behavioral risk:** LOW — existing retry behavior preserved with same defaults
**Key detail:** AbortController merging and transient error detection are the complex parts.

### #72 — Server Bootstrap Cleanup + Test File Split
**Area:** server, tests | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ All criteria checked (9/9)
**What changed:** Extracted `htmxNoContent` to shared utils. Split monolithic `server.test.ts` (1580 lines) into 5 domain-focused test files. Reduced `server.ts` to ~60 lines bootstrap.
**Files touched:** `src/utils/htmx-response.ts` (new), `tests/helpers/test-server.ts` (new), 5 new route test files, `server.test.ts` (deleted)
**Behavioral risk:** MEDIUM — large test refactor across 26 test files, 280 tests
**Key detail:** All 280 tests passing after split. In-memory DB isolation per test file.

### #71 — Polls Router + PollQueryService
**Area:** polls, routes | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ⚠️ Partial (CLOSED, checkboxes unchecked)
**What changed:** Extracted polls/run-history domain into dedicated route module with PollQueryService. Routes: `/polls`, `/polls/:id-detail`.
**Files touched:** `src/services/poll-query-service.ts` (new), `src/routes/polls-router.ts` (new), `src/server.ts`
**Behavioral risk:** MEDIUM — new service layer + router, pagination and 404 handling
**Key detail:** Acceptance criteria checkboxes remain unchecked — implementation may be incomplete.

### #70 — Admin Polling Router + PollTrigger Service
**Area:** admin, polling | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ⚠️ Partial (CLOSED, checkboxes unchecked)
**What changed:** Extracted admin polling domain into dedicated route module with PollTriggerService. Routes: POST `/admin/poll/trigger`, POST `/admin/poll/abort/:id`, GET `/admin/poll/progress`.
**Files touched:** `src/services/poll-trigger-service.ts` (new), `src/routes/admin-polling-router.ts` (new), `src/server.ts`
**Behavioral risk:** MEDIUM — background worker spawn, abort redirect, HTMX progress endpoint
**Key detail:** Acceptance criteria checkboxes remain unchecked — implementation may be incomplete.

### #69 — Admin Topics Router + TopicManager
**Area:** admin, topics | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ⚠️ Partial (CLOSED, checkboxes unchecked)
**What changed:** Extracted admin topics CRUD into dedicated route module with TopicManager. Routes: POST `/admin/topics`, `/admin/topics/update`, `/admin/topics/delete`.
**Files touched:** `src/services/topic-manager.ts` (new), `src/routes/admin-topics-router.ts` (new), `src/server.ts`
**Behavioral risk:** MEDIUM — force-delete behavior, HTMX row re-render
**Key detail:** Acceptance criteria checkboxes remain unchecked — implementation may be incomplete.

### #68 — Admin Channels Router + ChannelManager
**Area:** admin, channels | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ⚠️ Partial (CLOSED, checkboxes unchecked)
**What changed:** Extracted admin channels CRUD into dedicated route module with ChannelManager. Routes: POST `/admin/channels/add`, `/remove`, `/toggle`, `/update-topic`.
**Files touched:** `src/services/channel-manager.ts` (new), `src/routes/admin-channels-router.ts` (new), `src/server.ts`
**Behavioral risk:** MEDIUM — YouTube handle/URL resolution, RSS info fetch fallback
**Key detail:** Acceptance criteria checkboxes remain unchecked — implementation may be incomplete.

### #67 — Signals Router + SignalQueryService
**Area:** signals, routes | **Type:** refactor | **Closed:** 2026-05-28
**Status:** ⚠️ Partial (CLOSED, checkboxes unchecked)
**What changed:** First vertical slice establishing router/service pattern. Extracted signals domain into dedicated route module with SignalQueryService. Routes: GET `/signals`, `/signals/:id`, POST `/signals/:id/summarize`.
**Files touched:** `src/services/signal-query-service.ts` (new), `src/routes/signals-router.ts` (new), `src/server.ts`
**Behavioral risk:** MEDIUM — HTMX fragment swap, relevance toggle filter, topic/channel params
**Key detail:** Acceptance criteria checkboxes remain unchecked — implementation may be incomplete.

### #66 — Refactor large files into deep modules (parent epic)
**Area:** architecture | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ No criteria (CLOSED, no checkboxes)
**What changed:** Parent epic for 8 vertical slices (#67-#74). Target: no file exceeds 200 lines. Route module split, test file split, HTTP retry extraction, transcription merge extraction.
**Files touched:** Many files across src/ — see child issues #67-#74
**Behavioral risk:** HIGH — massive refactor affecting entire codebase structure
**Key detail:** This is the umbrella issue. Individual slice completion tracked in child issues.

### #65 — Topic inline edit — stale data after save
**Area:** admin, ui | **Type:** bugfix | **Closed:** 2026-05-28
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Extracted `_topicRow.ejs` partial. Update route returns re-rendered row HTML for HTMX requests instead of 204. Client-side Alpine swap via outerHTML.
**Files touched:** `views/admin/_topicRow.ejs` (new), `views/admin.ejs`, `src/server.ts`
**Behavioral risk:** LOW — UI-only fix, no data model changes
**Key detail:** HTMX response behavior change from 204 to 200 + HTML fragment.

### #64 — Admin panel: preserve tab state via HTMX boost
**Area:** admin, ui | **Type:** feature | **Closed:** 2026-05-27
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Replaced full POST→redirect pattern with HTMX AJAX submission. All admin forms use `hx-post` with `hx-swap="none"`. Server returns 204 for HTMX requests, 302 for non-HTMX fallback.
**Files touched:** `views/admin.ejs`, `src/server.ts` (admin POST routes)
**Behavioral risk:** LOW — progressive enhancement, non-HTMX fallback preserved
**Key detail:** Alpine.js tab state preserved across all admin form submissions.

### #63 — Extract prompt-building from llm.ts
**Area:** llm | **Type:** refactor | **Created:** 2026-05-27
**Status:** ❌ Open
**What will change:** Extract `buildMergedPrompt()` into separate `src/prompt.ts` module. Make prompt strategy swappable via `PromptBuilder` adapter.
**Files that will be touched:** `src/prompt.ts` (new), `src/llm.ts` (accept PromptBuilder)
**Behavioral risk:** MEDIUM — prompt template is core analysis logic
**Key detail:** `llm.ts` does 3 things in one file (250 lines). No way to swap prompt strategy currently.

### #62 — Consolidate signal deletion into seam
**Area:** db, signals | **Type:** refactor | **Created:** 2026-05-27
**Status:** ❌ Open
**What will change:** Create `src/signal-deletion.ts` with `deleteSignal(db, videoId, opts)` function. Unified transaction-based deletion for both abort and delete-video paths.
**Files that will be touched:** `src/signal-deletion.ts` (new), `src/abort.ts`, `src/delete-video.ts`
**Behavioral risk:** MEDIUM — deletion logic affects data integrity
**Key detail:** Two files currently have slightly different SQL for the same deletion pattern.

### #61 — Deepen Signal Ingestion pipeline
**Area:** poll, ingestion | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ No criteria (CLOSED, no checkboxes)
**What changed:** Created deep `ingestSignal(db, candidate): IngestResult` function encapsulating full per-candidate pipeline. Fixed duplicate counting bug (eliminated second RSS fetch).
**Files touched:** `src/poll.ts`, `src/poll-worker.ts`, `src/cli.ts`
**Behavioral risk:** MEDIUM — core ingestion pipeline change, two callers (worker + CLI)
**Key detail:** Double RSS fetch bug was confirmed at poll.ts lines 37-50.

### #60 — Deepen PollRun module
**Area:** db, polling | **Type:** refactor | **Closed:** 2026-05-29
**Status:** ✅ No criteria (CLOSED, no checkboxes)
**What changed:** Consolidated `poll-scheduler.ts` and `db/poll-runs.ts` into one deepened PollRun module. Rich interface with DB lifecycle + in-memory AbortController seam. Deleted inline SQL from server.
**Files touched:** `src/db/poll-runs.ts` (deepened), `src/poll-scheduler.ts` (deleted), `src/server.ts`
**Behavioral risk:** MEDIUM — three shallow modules merged, server no longer does raw inline SQL
**Key detail:** In-memory AbortController registry moved into poll-runs as companion seam.

### #59 — Collapse watchlist.ts + topics.ts into WatchList module
**Area:** db, watchlist | **Type:** refactor | **Closed:** 2026-05-27
**Status:** ✅ No criteria (CLOSED, ~90% complete per issue body)
**What changed:** Merged shallow `watchlist.ts` and `topics.ts` into deep WatchList module. Deep LEFT JOIN queries eliminate N+1. FK pragma hack removed — proper transaction with ordered deletes.
**Files touched:** `src/db/watchlist.ts` (deepened), `src/db/topics.ts` (deleted)
**Behavioral risk:** MEDIUM — ~10% cleanup remaining in server.ts (N+1 queries, test imports)
**Key detail:** Issue body notes ~90% complete with remaining server.ts line updates needed.

### #58 — Topics tab: readonly/edit fields visible simultaneously
**Area:** admin, ui | **Type:** bugfix | **Closed:** 2026-05-27
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Replaced `x-if` with `x-show` + `x-cloak` on edit-mode elements. Single-row-edit constraint via top-level `editId` reactive property.
**Files touched:** `views/admin.ejs`
**Behavioral risk:** LOW — pure UI fix, no data changes
**Key detail:** Zero flicker toggle. Clicking Edit on row B cancels edit on row A.

### #57 — In-place row editing for Topics tab
**Area:** admin, ui | **Type:** feature | **Closed:** 2026-05-27
**Status:** ⚠️ Partial (CLOSED, some checkboxes unchecked)
**What changed:** Replaced two-row swap pattern with in-place cell-level inline editing. Alpine.js toggle within single `<tr>`. E2E tests for edit/save/cancel flow.
**Files touched:** `views/admin.ejs`, `tests/e2e/admin.spec.js` (4 new tests)
**Behavioral risk:** MEDIUM — Invalid HTML (`<form>` inside `<tbody>`) noted as problem
**Key detail:** Acceptance criteria shows remaining issues with invalid HTML structure.

### #56 — Signal Viewer: hierarchical Topic→Channel filter pills
**Area:** signals, ui | **Type:** feature | **Closed:** 2026-05-26
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Two-row filter bar: Topic pills above Channel pills. Alpine.js store with `selectedTopic`, `selectedChannel`, `filteredChannels` computed. Query layer gains `topicKey` filter with JOIN.
**Files touched:** `src/query.ts`, `src/server.ts`, `views/signals.ejs`, `views/_signalsTable.ejs`
**Behavioral risk:** MEDIUM — new query param, HTMX swaps for topic+channel combo
**Key detail:** Topic + Channel combo filter requires JOIN in SQL query.

### #55 — Poll worker: skip NULL-topic channels
**Area:** poll, worker | **Type:** feature | **Closed:** 2026-05-26
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Poll worker uses `listActiveChannels()` which filters `WHERE active = 1 AND topic_id IS NOT NULL`. Warning log for skipped channels.
**Files touched:** `src/poll-worker.ts`, `src/db/watchlist.ts`
**Behavioral risk:** LOW — guard clause, no behavioral change for valid channels
**Key detail:** LLM analysis now receives correct filter_text from Topic for each signal.

### #54 — LLM prompt uses Topic filter_text
**Area:** llm | **Type:** feature | **Closed:** 2026-05-26
**Status:** ✅ No criteria (CLOSED, checkboxes unchecked but issue closed)
**What changed:** Replaced hardcoded MTG analyst role with generic "You are a content analyst." Filter text resolved from Topic via JOIN instead of per-channel `filter_criteria`.
**Files touched:** `src/llm.ts`
**Behavioral risk:** MEDIUM — core prompt template change affects all LLM analysis
**Key detail:** JSON response structure unchanged. Missing `relevant` field still treated as true (backward compat).

## Unimplemented Features (expected but not delivered)

### #63 — Extract prompt-building from llm.ts into Prompt Template seam
**Area:** llm | **Type:** refactor | **Created:** 2026-05-27
**Why it matters:** `llm.ts` still does 3 things in one file (250 lines). Prompt template is hard to test independently and not swappable. No per-topic prompt variants possible.

### #62 — Consolidate signal deletion into Signal Deletion seam
**Area:** db, signals | **Type:** refactor | **Created:** 2026-05-27
**Why it matters:** Duplicate deletion pattern in `abort.ts` and `delete-video.ts` with slightly different SQL. No transaction safety in delete-video path.

---
<!-- CACHE: last_processed=78 | generated_at=2026-05-30T23:27:00Z -->
<!-- ENTRIES: 25 -->