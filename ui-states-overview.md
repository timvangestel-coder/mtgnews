# UI States Overview — Poll Run Lifecycle

> **Last updated:** 2026-06-03 | Issue #82 implemented: `pending` → `fetching`, alphabetical channel ordering, aborted run display logic | Issue #84 implemented: abort button converted to HTMX POST for inline widget swap (no tab reset)

---

## 1. Data Model

### RunState (view model) — `src/poll-run-manager.ts`

```typescript
RunState {
  id: number
  status: 'running' | 'complete' | 'failed' | 'aborted'
  steps: PollRunStep[]
}

PollRunStep {
  displayName: string | null
  status: 'fetching' | 'processing' | 'done' | 'failed' | 'skipped' | 'partial'
  total: number      // signals discovered for this channel
  done: number       // signals processed (relevant + irrelevant + failed)
}
```

**Channel ordering:** Steps are sorted alphabetically by `displayName` (NULLs first) via `ORDER BY c.display_name ASC` in the progress query. This order remains stable throughout the entire run lifecycle — channels never change position.

**Removed in issue #79:** `phase`, `signalsAnalyzed`, `summary` (PollRunSummary), `analysis` (PollRunAnalysis). All derivable from `steps[]`.

**Eliminated in issue #80:** Two-phase model (Phase 1: poll all → Phase 2: analyze all). Replaced with single streaming pipeline.

### DB Tables

- **poll_runs**: `id, triggered_at, status, new_signal_count, completed_at, lookback_days, abort_time`
- **poll_run_progress**: `poll_run_id, channel_id, status, signals_found, signals_done, updated_at`

**Removed from queries:** `phase`, `signals_analyzed`, `signals_to_analyze` columns are no longer selected in DB queries (columns still exist in schema for existing databases but are unused).

**Key:** `signals_done` tracks per-channel analysis progress. Incremented after each signal completes (including failures) — counts relevant, irrelevant, and failed signals. Channel status transitions from `'processing'` to `'done'` when `signals_done >= signals_found`.

---

## 2. UI Components & Color Mapping

### Progress Widget — Running State (`state.status === 'running'`)

| Element | Text | Color Class | Visual Color |
|---------|------|-------------|--------------|
| Run header | "Run #N — running..." | `text-amber-600` | **orange** |
| Abort button | "Abort Run" | `bg-red-600` | **red bg, white text** |

**Removed:** Global "Analyzing signals... X/Y" banner. Progress is now shown per-channel only.

### Step (per-channel row) — 6-branch logic for running state

| Condition | Display Text | Color Class | Visual Color |
|-----------|--------------|-------------|--------------|
| `status === 'fetching'` | "fetching" | `text-blue-600` | **blue** |
| `status === 'failed'` | "failed" | `text-red-600` | **red** |
| `total === 0` | "none" | `text-gray-400` | **grey** |
| `processing` or `done < total`, total > 0 | "X/Y" | `text-blue-600` | **blue** |
| `done >= total`, total > 0 | "Y/Y" | `text-green-600` | **green** |

**"fetching" state:** Covers the full pre-LLM phase for each channel (RSS discovery + caption extraction via yt-dlp + DB insert). The channel shows "fetching" from the moment it is reached by the worker until all transcripts are stored and the first signal counter appears. No animated indicator — just blue text.

### Step (per-channel row) — Aborted state logic

| Condition | Display Text | Color Class | Visual Color |
|-----------|--------------|-------------|--------------|
| `done === 0` (signals deleted by abort) | "skipped" | `text-gray-400` | **grey** |
| `0 < done < total` (partial work at abort) | "X/N" | `text-amber-600` | **amber/orange** |
| `done >= total` (all summaries completed) | "N/N" | `text-green-600` | **green** |
| `status === 'failed'` | "failed" | `text-red-600` | **red** |
| `total === 0` | "none" | `text-gray-400` | **grey** |

**Important:** Done label is just "X/X" in green — no "done" prefix. During processing, channels show "X/Y" (e.g., "2/5") in blue. A channel shows "Y/Y" as soon as all its signals are processed, even while other channels are still being processed.

### Progress Widget — Completed/Failed/Aborted State (`state.status !== 'running'`)

| state.status | Header Text | Color Class | Visual Color |
|--------------|-------------|-------------|--------------|
| `complete` | "Run #N — complete" | `text-green-600` | **green** |
| `aborted` | "Run #N — aborted" | `text-amber-600` | **orange** |
| `failed` | "Run #N — failed" | `text-red-600` | **red** |

Step rows use the aborted state logic (skipped/partial/done) when `state.status === 'aborted'`, or the standard running-state logic for `complete`/`failed`.

### No Run State

Text: "No poll runs yet." in `text-gray-500` (**grey**)

---

## 3. HTMX Polling Mechanism

```
Progress Widget (#progress-widget)
├── hx-get="/admin/poll/progress"     ← polls every 3 seconds
├── hx-trigger="every 3s"             ← automatic refresh interval
└── hx-swap="outerHTML"               ← replaces entire widget div
```

Two render paths produce the same widget:
1. **Initial trigger**: `POST /admin/poll/trigger` → renders `_pollProgress.ejs` inline into `#progress-widget`
2. **Polling refresh**: `GET /admin/poll/progress` → renders `_pollProgress.ejs` every 3s

Both paths use the same template (`views/admin/_pollProgress.ejs`) and same data source (`manager.runState()`).

---

## 4. Source Files → UI Update Flow

```
User clicks "Run Poll Now"
  │
  ▼
htmx POST /admin/poll/trigger          ← views/admin.ejs (Polling tab)
  │
  ├─ manager.startRun(lookbackDays)    ← poll-run-manager.ts:78
  │    │
  │    ├─ enqueuePollRun()             ← inserts row: status='running'
   │    ├─ preRegisterChannelProgress() ← poll-runs.ts:4 — inserts 'fetching' rows
  │    └─ workerProcessRun()           ← background async (non-blocking)
  │
  ▼
manager.runState(runId)                ← poll-run-manager.ts:98
  │
  ├─ getPollRunById()                  ← reads run row + computed cols (no phase/signals_analyzed)
  ├─ queryPollRunProgress()            ← reads progress rows with signalsDone
  └─ builds RunState view model        ← maps status, steps[] only
  │
  ▼
res.render('admin/_pollProgress')      ← renders _pollProgress.ejs
  │
  └── HTMX swaps into #progress-widget  ← page shows widget (no reload)
       │
       └── Every 3s: GET /admin/poll/progress → same render cycle
```

### Worker → DB → UI Update Chain (Streaming Pipeline)

```
workerProcessRun() runs in background (SINGLE STREAMING PIPELINE):
  │
  ├─ Create global ConcurrencyPool(LLM_CONCURRENCY=3)
  │
  └─ FOR each active channel (with topic_id):
       │
       ├─ await pollChannel(...)     ← RSS fetch + signal ingestion (no DB write yet)
       │
       ├─ IF signals found (N > 0):
       │   │
       │   ├─ upsertProgress(channelId, 'processing', N)
       │   │   → DB: status='processing', signals_found=N, signals_done=0
       │   │   → UI (next poll): "0/N" — blue (mapped to 'processing')
       │   │
       │   └─ FOR each signal:
       │        pool.run(() => {
       │          await analyzeSignal(...)  ← dispatched to global concurrency pool
       │          incrementDone(channelId)  → signals_done += 1
       │                                     → when done>=total: status='done'
       │                                     → UI: "X/Y" blue → "Y/Y" green
       │        })
       │
       └─ IF no signals (N === 0):
           upsertProgress(channelId, 'done', 0)
             → DB: status='done', signals_found=0
             → UI: "none" — grey

  ├─ await pool.drain()              ← wait for all analysis tasks to complete
  │
  └─ UPDATE poll_runs SET status='done'
      → UI: "Run #N — complete" — green header
```

**Key difference from old two-phase model:**
- **Old**: Poll ALL channels first (collecting work items), THEN analyze ALL signals in batches
- **New**: Per channel: poll → discover → immediately dispatch analysis to global pool → next channel
- Analysis tasks from different channels run concurrently through the shared pool

---

## 5. Complete Step-by-Step Example Run

### Setup
- **Channel A** ("Tech News Daily"): active, has topic_id → 6 new videos found
- **Channel B** ("Two Minute Papers"): active, has topic_id → 1 new video found
- **Channel C** ("Zen van Riel"): active, has topic_id → 0 new videos

### Step 0: Before trigger

```
┌─ Progress Widget ───────────────────────┐
│ No poll runs yet.                        │  ← grey text
└─────────────────────────────────────────┘
```

**DB:** No `poll_runs` row, no progress rows.

### Step 1: User clicks "Run Poll Now" (t=0s)

**DB writes:** `INSERT poll_runs` → runId=N; `INSERT poll_run_progress ×3` as 'fetching'

Channels are displayed alphabetically by display name (NULLs first). Order stays fixed throughout the run.

```
┌─ Progress Widget ───────────────────────┐
│ Run #N — running...         [Abort Run] │  ← orange, red button
│                                          │
│ Tech News Daily          fetching       │  ← blue
│ Two Minute Papers        fetching       │  ← blue
│ Zen van Riel             fetching       │  ← blue
└─────────────────────────────────────────┘
```

### Step 2: Channel A polled — found 6 signals (t=~4s)

**DB:** `status='processing', signals_found=6, signals_done=0` for Channel A; 6 analysis tasks dispatched to pool

```
│ Tech News Daily          0/6            │  ← blue (processing, done=0)
│ Two Minute Papers        fetching       │  ← blue
│ Zen van Riel             fetching       │  ← blue
```

### Step 3: Channel B polled — found 1 signal (t=~5s)

**DB:** `status='processing', signals_found=1, signals_done=0` for Channel B; 1 analysis task dispatched to pool

```
│ Tech News Daily          0/6            │  ← blue
│ Two Minute Papers        0/1            │  ← blue
│ Zen van Riel             fetching       │  ← blue
```

### Step 4: Channel C polled — found 0 signals (t=~6s)

**DB:** `status='done', signals_found=0` for Channel C; no analysis tasks dispatched

```
│ Tech News Daily          0/6            │  ← blue
│ Two Minute Papers        0/1            │  ← blue
│ Zen van Riel             none           │  ← grey (no signals)
```

### Step 5: Analysis starts — first batch completes (t=~12s)

With `LLM_CONCURRENCY=3`, tasks run in parallel across channels. Suppose 2 from A + 1 from B complete.

**DB:** A: `signals_done=2`; B: `signals_done=1` → B transitions to `'done'` (done>=total)

```
│ Tech News Daily          2/6            │  ← blue, progress visible
│ Two Minute Papers        1/1            │  ← green! all TMP signals done
│ Zen van Riel             none           │  ← grey
```

**Key:** Analysis tasks from different channels share the global concurrency pool. Channel B shows "1/1" (green) as soon as its single signal is analyzed, even while A still has 4 remaining.

### Step 6: Remaining signals analyzed (t=~20s)

Remaining 4 Alpha signals processed in batches of 3+1.

```
│ Tech News Daily          2/6 → 5/6 → 6/6 │  ← increments, then green
│ Two Minute Papers        1/1             │  ← stays green
│ Zen van Riel             none            │  ← stays grey
```

### Step 7: All signals analyzed — Run complete

**DB:** `status='done', new_signal_count=7`

```
┌─ Progress Widget ───────────────────────┐
│ Run #N — complete                        │  ← green header
│                                          │
│ Tech News Daily          6/6             │  ← green
│ Two Minute Papers        1/1             │  ← green
│ Zen van Riel             none            │  ← grey
└─────────────────────────────────────────┘
```

---

## 6. Alternative Scenarios

### Abort Mid-Processing

User clicks "Abort Run" at Step 5 (Channel A had 2/6 summarized, Channel B had 1/1, Channel C had none):

```
│ Run #N — aborted                         │  ← orange header
│                                          │
│ Tech News Daily          2/6             │  ← amber/orange (partial work)
│ Two Minute Papers        1/1             │  ← green (all summaries completed)
│ Zen van Riel             skipped         │  ← grey (0 summaries, signals deleted)
```

**Worker:** `abortPollRun()`:
1. Fires `AbortController` → cancels in-flight LLM calls
2. Deletes signals where `processed_at IS NULL` (unsummarized)
3. Sets `status='done-forced'`, counts remaining processed signals
4. `mapStatus('done-forced')` → `'aborted'`

**Aborted run display logic:** For each channel progress row at abort time:
- `signals_done === 0`: Show "skipped" (grey) — all signals were deleted by abort
- `0 < signals_done < signals_found`: Show "X/N" (amber) — partial work, N-X signals deleted
- `signals_done >= signals_found`: Show "N/N" (green) — all summaries survived

**Note:** Progress rows (`signals_done`) are NOT reset by abort. They reflect work done before the abort. The UI interprets them differently based on run status (running vs aborted).

**Fix in issue #83:** The worker's pool callbacks guard `incrementDone()` with `signal?.aborted` so in-flight analysis tasks that settle after abort cleanup don't inflate counters. Aborted tasks on the AbortError path skip `incrementDone()` entirely. This ensures channels whose signals were all deleted by abort correctly show "skipped" (grey) rather than a phantom "N/N" (green).

### Channel fails during polling

If `pollChannel()` throws for a channel:

```
│ Tech News Daily          6/6            │  ← green
│ Two Minute Papers        failed         │  ← red
│ Zen van Riel             none           │  ← grey
```

Worker catches error: `upsertProgress(channelId, 'failed', 0)`

### LLM analysis fails for a signal

If `analyzeSignal()` throws (e.g., LLM endpoint down):
- Error logged: `analyzeSignal failed for {videoId}: {message}`
- `done` counter IS still incremented (decision from issue #80)
- Run continues with remaining signals (no cascade failure)

### Aborted analysis does NOT increment done counter (issue #83 fix)

If `analyzeSignal()` is aborted mid-flight via AbortController:
- The abort cleanup deletes the unsummarized signal from the DB
- The pool callback detects `signal?.aborted` and skips `incrementDone()`
- This prevents phantom counter inflation that would cause "N/N green" in the UI for channels whose signals were deleted by abort

---

## 7. Counter Increment Robustness

Each counter increment is wrapped in a DB transaction — failures are visible, not silent:

```typescript
const incrementDone = (channelId: string) => {
  this.db.transaction(() => {
    // Increment done counter
    db.prepare('UPDATE poll_run_progress SET signals_done += 1').run(...)
    // Transition to 'done' when all signals processed
    if (signals_done >= signals_found && signals_found > 0) {
      db.prepare("UPDATE poll_run_progress SET status = 'done'").run(...)
    }
  })()
}
```

**Benefits:**
- Atomic increment + status transition
- Failed analyses still increment counters (explicit design decision)
- Aborted analyses do NOT increment counters (issue #83 fix — prevents phantom inflation after abort cleanup)
- Each channel transitions to `'done'` independently when its signals are all processed

---

## 8. State Transition Diagrams

### Run Lifecycle:
```
[no run] → running → complete
                ↘ aborted (via abort)
                ↘ failed (via unhandled error)
```

### Step Lifecycle (per channel) — Active run:
```
fetching → processing → done
           ↘ failed
```

**Streaming pipeline:** Each channel independently transitions through states. Channels with signals go `fetching → processing → done` as analysis completes. Channels without signals go `fetching → done` directly.

### Step Lifecycle (per channel) — Aborted run:
```
fetching → skipped (grey)       ← 0 summaries completed, all signals deleted
processing → skipped (grey)     ← 0 summaries completed, all signals deleted
processing → partial (amber)    ← X of N summaries completed (0 < X < N)
processing → done (green)       ← All N summaries completed before abort
```

---

## 9. Files Summary

| File | Responsibility |
|------|---------------|
| `src/poll-run-manager.ts` | Core lifecycle: enqueue, streaming worker (ConcurrencyPool), abort, runState() |
| `src/db/poll-runs.ts` | DB queries: preRegisterChannelProgress, getPollRunById, queryPollRunProgress |
| `src/routes/admin-polling-router.ts` | HTTP: POST /trigger, GET /progress, POST /abort/:id |
| `src/routes/admin-router.ts` | GET /admin — passes currentRunState to admin.ejs |
| `views/admin.ejs` | Admin page with Polling tab (includes _pollProgress partial) |
| `views/admin/_pollProgress.ejs` | Progress widget partial — single source of truth for rendering |

---

## 10. Known Behaviors

### Irrelevant signals count in progress
Signals marked `relevance_status='irrelevant'` by the LLM:
- DO increment per-channel `signals_done` ✓
- Do NOT set `processed_at` (remain queryable for re-analysis)
- Display as "X/Y" in UI until all channel signals processed, then "Y/Y"

### Failed signals also count in progress
Signals whose analysis throws an error:
- DO increment per-channel `signals_done` ✓ (issue #80 decision)
- Channel still transitions to `'done'` when `done >= total`

### Channel shows "Y/Y" before run completes
During processing, a channel whose all signals are analyzed shows "Y/Y" (green) even while other channels still show "X/Y" (blue). This is correct — it means that specific channel's work is complete.

### Zen van Riel stays "none" throughout
Channels with 0 new signals found during polling display as "none" (grey) for the entire run. They never transition to processing because there are no work items for them.

### Streaming vs Two-Phase (issue #80)
The worker now uses a single streaming pipeline instead of two phases:
- **No phase transitions**: No `UPDATE poll_runs SET phase=...` SQL ever runs
- **No global counters**: `signals_analyzed` and `signals_to_analyze` remain at 0 (unused)
- **Immediate dispatch**: Analysis tasks are dispatched to the global pool as soon as each channel's signals are discovered, not batched after all channels are polled
- **Shared concurrency**: Tasks from different channels compete for slots in the same `ConcurrencyPool(LLM_CONCURRENCY=3)`

---

## 11. Admin Page — Tab Navigation & Abort Behavior

### Tab System (`views/admin.ejs`)

Three tabs managed by Alpine.js `x-data` with `<template x-if>`:
| Tab | Route Param | Default? |
|-----|-------------|----------|
| Channels | `?tab=channels` | **Yes** — defaults when no param provided |
| Topics | `?tab=topics` | No |
| Polling | `?tab=polling` | No |

Tab buttons use `history.replaceState()` for client-side navigation only — no page reload. The server reads `req.query.tab` on full-page loads and passes it to the template for initial Alpine state.

### Abort Button — Behavior (issue #84 implemented)

The abort button in `_pollProgress.ejs` uses an **HTMX POST** for inline widget swap:
```html
<form hx-post="/admin/poll/abort/<%= state.id %>"
      hx-target="#progress-widget" hx-swap="outerHTML"
      hx-confirm="Abort this run? Unsummarized signals will be deleted.">
```

Server returns `res.render('admin/_pollProgress', { state, layout: false })` with the aborted RunState — same template as GET `/admin/poll/progress`. HTMX swaps it into `#progress-widget` inline. No full-page reload, tab state preserved.

Error path: server renders the progress widget with an inline error banner (`<div role="alert">` with red styling) instead of redirecting with a query parameter.

### Admin Operation Response Patterns

| Operation | Client Mechanism | Server Response | Tab Preserved? |
|-----------|-----------------|-----------------|----------------|
| Add Channel | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Remove Channel | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Toggle Active | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Change Topic | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Add Topic | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Update Topic | `hx-post` + inline render | Re-rendered row HTML | ✅ Yes |
| Delete Topic | `hx-post` + `hx-swap="none"` | HX-Redirect header | ✅ Yes |
| Run Poll Now | `hx-post` + target/swap | Inline widget render | ✅ Yes |
| **Abort Run** | **`hx-post` + target/swap** | **Inline widget render** | ✅ Yes |
