# Big Chunk 113-121 — Complete Discussion Summary

## Origin

The user wanted two changes to the Signal List:
1. Add a column for Q&A progress (format "X/Y" — answered/total questions)
2. Have the LLM generate a title for each signal's summary, displayed instead of the truncated Summary column

This triggered an architecture review that uncovered a fundamental bug in the Chat system's concurrency handling, leading to a broader redesign.

---

## Part 1: Architecture Review (improve-codebase-architecture)

### Problem Discovered

When two chat questions are submitted simultaneously on different signals, both hit LM Studio directly with **no concurrency control**. The Poll system uses a `ConcurrencyPool` (limit 3) for LLM analysis, but Chat routes around it entirely. This causes:
- LM Studio overload from concurrent requests
- Second+ requests appear to process but don't persist reliably
- Browser disconnect during streaming loses the answer entirely

### Root Cause Analysis

**Current flow (tightly coupled):**
```
Browser POST → Router holds response open → ChatManager streams → DB writes on completion
Browser closes tab → stream aborts → no DB write
```

**Poll pattern (already async/decoupled):**
```
POST /admin/poll/trigger → returns runId immediately
  Worker processes in background (independent of HTTP)
  UI polls GET /progress via hx-trigger="every 3s"
  Progress tracked in DB tables
  ConcurrencyPool limits parallel LLM calls
```

### Architecture Review Report

Published to `%TEMP%/architecture-review-mtgnews-chat-concurrency-20260607.html` with two candidates:

1. **[Strong] Route Chat Through Concurrency Pool** — Add queuing layer between router and ChatManager, reusing ConcurrencyPool pattern
2. **[Worth exploring] Add Pending State to Signal Chat** — Make `answer` nullable to track "asked but not answered" state

---

## Part 2: grill-with-docs Decision Log

### Q1 — Shared Pool Integration (Answer: A)

**Question:** How should the global ConcurrencyPool be shared between Poll and Chat?

- **A — Single global pool, one limit.** All LLM work shares `LLM_CONCURRENCY` slots. Simplest. ✅ CHOSEN
- B — Two pools, separate limits
- C — Single global pool, per-run sub-limits with priority

**Decision:** Single global pool created in `server.ts`, passed to both PollRunManager and ChatQueue. PollRunManager refactored to accept pool as dependency instead of creating its own per run.

### Q2 — X/Y Ratio Denominator (Answer: A)

**Question:** Should failed questions (answer=NULL) count in the denominator?

- **A — Count all rows.** `COUNT(*)` from `signal_chat`. Failed questions still count. ✅ CHOSEN
- B — Only count non-failed rows

**Decision:** Simple query: `COUNT(answer IS NOT NULL) / COUNT(*)`. Failed questions are user actions and should show in the ratio.

### Q3 — Title Generation Point (Answer: A)

**Question:** When should the LLM generate the title?

- **A — Same LLM call as Signal analysis.** Add `"title"` field to existing JSON response. Zero extra API calls. ✅ CHOSEN
- B — Separate LLM call after analysis

**Decision:** Marginal cost of one extra string field is near zero. Prompt instructs: `"title": "A concise title capturing the main topic, max 100 characters"`.

### Q4 — Title Max Length (Answer: B)

**Question:** How to limit title length?

- A — Dynamic limit based on original title length
- **B — Fixed 100 chars.** Simpler, consistent UI column width. ✅ CHOSEN

**Decision:** Two layers of protection:
1. Prompt instruction: "max 100 characters" (soft constraint)
2. Application truncation: `.substring(0, 100)` (hard safety net)

### Additional Decision — Chat Decoupling Design

The user requested three capabilities:
1. Answer appears when done if chat window is open
2. Navigate away and come back later → continue waiting or read answer
3. Make chat questions behave similarly to poll runs

**Decision:** Full async decoupling (no real-time streaming). Chat behaves like Poll — submit → background process → poll for result. HTMX polling (`hx-trigger="every 2s"`) replaces SSE streaming.

### Additional Decision — Failed Questions (Answer: A)

**Question:** When a question fails, what happens to the DB row?

- **A — Left with `answer=NULL` permanently.** User sees it as "failed", can retry. ✅ CHOSEN
- B — Deleted on failure
- C — Explicit `status` column added

**Decision:** Minimal schema change. `answer IS NULL` = pending/failed. UI distinguishes by age (recent NULL = "processing...", old NULL = "failed").

---

## Part 3: CONTEXT.md Updates

### Updated Terms

| Term | Change |
|------|--------|
| **SignalChat** | Rewritten: async job pattern, two-phase lifecycle, HTMX polling, Q&A ratio formula |
| **ChatManager** | Rewritten: split into `submit()` + process method, no streaming |
| **Generated Title** | NEW: AI-generated title, same LLM call, max 100 chars, fallback to original title |
| **Concurrency Pool** | Updated: single global instance shared by Poll + Chat |

### Signal List View Spec Updated

Columns changed from: `Published | Time | Summary (50-char truncated) | Sentiment`

To: `Published | Time | Q&A Ratio (X/Y) | Title (generated or original) | Sentiment`

---

## Part 4: ADR Created

**docs/adr/0006-async-chat-job-pattern.md**

Records the decision to switch SignalChat from synchronous SSE streaming to async job pattern. Three driving factors:
1. Concurrent chat requests had no concurrency control → LM Studio overload, lost answers
2. Synchronous model prevented tracking pending questions for X/Y ratio
3. Browser disconnect during streaming would lose the answer entirely

Considered options documented (SSE with queue rejected; SSE reconnect deferred).

---

## Part 5: Issue Breakdown (6 Vertical Slices)

### Slice Chain A — Generated Title

**#114 — Add Generated Title to Signal Analysis** (ready-for-agent, independent)
- DB migration: `ALTER TABLE signals ADD COLUMN generated_title TEXT`
- LLM prompt: add `"title"` field to JSON schema with "max 100 chars" instruction
- Response parsing: extract title from LLM JSON, truncate to 100 chars, persist in DB
- Tests: migration runs; title stored correctly; truncation works

**#115 — Display Generated Title in Signal List** (ready-for-agent, blocked by #114)
- Query: include `generated_title` with fallback to `title` when NULL
- Template: replace "Summary" column header with "Title"; display generated/original title
- Irrelevant signals show `[Irrelevant]`
- Tests: fallback logic renders correctly

### Slice Chain B — Q&A Ratio (Independent)

**#116 — Add Q&A Ratio Column to Signal List** (ready-for-agent, independent)
- Query: correlated subquery counting `COUNT(answer IS NOT NULL)` and `COUNT(*)` from `signal_chat` per signal
- Template: add "Q&A" column showing "X/Y" format; signals with 0 questions show "—"
- Tests: ratio for signals with 0, 1, multiple questions including failed ones

### Slice Chain C — Chat Async Redesign

**#117 — Make Chat Answer Nullable + Two-Phase Persist** (ready-for-agent, independent)
- DB migration: alter `signal_chat.answer` from NOT NULL to nullable
- Split `ChatManager.ask()` into `submit(signalVideoId, question)` → INSERT with NULL; internal process method → UPDATE on success
- Failed questions leave `answer=NULL` permanently
- Tests: two-phase persist verified; failed question leaves NULL

**#120 — Build ChatQueue with Global ConcurrencyPool** (ready-for-agent, blocked by #117)
- New module: `src/chat-queue.ts` wrapping global pool
- Server: create single `ConcurrencyPool(LLM_CONCURRENCY)` instance, pass to PollRunManager + ChatQueue
- PollRunManager refactored: accept pool as constructor dependency
- Router: POST `/chat/ask` returns immediately after submit; new GET `/chat/:id/status` endpoint
- Tests: concurrent requests queued and all persist; pool shared between Poll and Chat

**#121 — HTMX Polling UI for Pending Questions** (ready-for-agent, blocked by #120)
- Template: `_chatHistory.ejs` shows "processing..." spinner on NULL answer rows with `hx-trigger="every 2s"` polling
- Signal Detail page: update Alpine.js to reload history after submit instead of streaming
- Failed rows show "failed" indicator
- Tests: pending renders; auto-refreshes on completion

### Duplicates Cleaned Up

- #118 → duplicate of #114 (closed)
- #119 → duplicate of #115 (closed)

---

## Part 6: Implementation Progress

### Completed (as of session end)

| File | Change | Status |
|------|--------|--------|
| `src/db/init-db.ts` | Added `generated_title TEXT` column migration | ✅ Done |
| `src/prompt-assembler.ts` | Updated default prompt with `"title"` field in JSON schema | ✅ Done |
| `CONTEXT.md` | Updated SignalChat, ChatManager, Generated Title, Concurrency Pool terms | ✅ Done |
| `docs/adr/0006-async-chat-job-pattern.md` | New ADR documenting chat decoupling decision | ✅ Done |

### Remaining (per issue)

| Issue | Remaining Work |
|-------|----------------|
| #114 | Response parsing in `llm.ts`: extract title from JSON, truncate to 100 chars, add to UPDATE statement |
| #115 | Query update + template change (blocked by #114) |
| #116 | Correlated subquery + new column in template (independent) |
| #117 | DB migration + ChatManager refactor (independent) |
| #120 | New chat-queue module + server integration (blocked by #117) |
| #121 | Template updates + Alpine.js changes (blocked by #120) |

---

## Part 7: Key Technical Details for Implementation

### LLM Response Parsing (#114 remaining work)

Current `MergedAnalysisResponse` interface in `src/llm.ts`:
```typescript
interface MergedAnalysisResponse {
  summary: string;
  takeaways: Array<{ text: string; timestamp: string }>;
  overall_sentiment: { score: number; label: string };
  entities: Array<{ entity_name: string; entity_type: string; sentiment: string }>;
  relevant?: boolean;
}
```

Needs `title` field added. Then in the UPDATE statement (line 218-221), add `generated_title = ?`:
```typescript
const generatedTitle = (analysis.title || '').substring(0, 100);
db.prepare(`
  UPDATE signals SET summary = ?, overall_sentiment = ?, sentiment_label = ?, generated_title = ?
  WHERE video_id = ?
`).run(summaryDisplay, clampedScore, analysis.overall_sentiment.label, generatedTitle, videoId);
```

### Q&A Ratio Query (#116)

Correlated subquery pattern for Signal List:
```sql
SELECT s.*, 
  (SELECT COUNT(*) FROM signal_chat sc WHERE sc.signal_video_id = s.video_id) as total_questions,
  (SELECT COUNT(*) FROM signal_chat sc WHERE sc.signal_video_id = s.video_id AND sc.answer IS NOT NULL) as answered_questions
FROM signals s ...
```

Template renders: `answered > 0 ? `${answered}/${total}` : '—'`

### ChatManager Two-Phase Pattern (#117)

Current `ask()` method (line 62-101 in chat-manager.ts):
- Streams tokens via AsyncGenerator
- Buffers answer in memory
- INSERT on completion only

New pattern:
```typescript
submit(signalVideoId, question): number {
  const result = this.db.prepare(
    'INSERT INTO signal_chat (signal_video_id, question) VALUES (?, ?)'
  ).run(signalVideoId, question);
  return Number(result.lastInsertRowid);
}

async process(questionId: number): Promise<void> {
  // Resolve context → assemble prompt → call LLM via global pool → UPDATE on success
  const row = this.db.prepare('SELECT * FROM signal_chat WHERE id = ?').get(questionId);
  // ... resolve, assemble, call LLM ...
  this.db.prepare('UPDATE signal_chat SET answer = ? WHERE id = ?').run(answer, questionId);
}
```

### Global ConcurrencyPool (#120)

Current: `PollRunManager.workerProcessRun()` creates `new ConcurrencyPool(concurrency)` per run.

New: Pool created in `server.ts`, passed to both managers:
```typescript
const pool = new ConcurrencyPool(parseInt(process.env.LLM_CONCURRENCY || '3', 10));
const pollRunManager = new PollRunManager(db, pool);
const chatQueue = new ChatQueue(chatManager, pool);
```

PollRunManager constructor changes from `constructor(private db)` to `constructor(private db, private pool)`.

---

## Part 8: Files Modified During This Session

| File | Change Type | Description |
|------|-------------|-------------|
| `CONTEXT.md` | Updated | SignalChat, ChatManager, Generated Title, Concurrency Pool terms; Signal List View spec |
| `docs/adr/0006-async-chat-job-pattern.md` | Created | ADR for chat async decoupling decision |
| GitHub Issues #114-#121 | Created | 6 vertical slices + 2 duplicates closed |

## Files NOT Yet Modified (pending implementation)

| File | Pending Change |
|------|----------------|
| `src/db/init-db.ts` | Add `generated_title TEXT` migration; alter `signal_chat.answer` nullable |
| `src/prompt-assembler.ts` | Update default prompt with title field |
| `src/llm.ts` | Parse title from LLM response, persist in DB |
| `src/query.ts` | Include `generated_title`; add Q&A ratio subquery |
| `views/_signalsTable.ejs` | Replace Summary column; add Q&A column |
| `src/services/chat-manager.ts` | Split into submit/process methods |
| `src/chat-queue.ts` | New module: queue wrapper around global pool |
| `src/server.ts` | Create global pool; pass to managers |
| `src/poll-run-manager.ts` | Accept pool as dependency |
| `src/routes/chat-router.ts` | POST returns immediately; GET status endpoint |
| `views/_chatHistory.ejs` | HTMX polling on pending rows |
| `views/signal-detail.ejs` | Update Alpine.js for async chat |

---

## Session Timeline

1. User requests two Signal List changes (Q&A ratio + generated title)
2. grill-with-docs session begins → questions about Q&A state model
3. Discovered fundamental bug: concurrent chat requests bypass concurrency controls
4. Switched to improve-codebase-architecture → HTML report with 2 candidates
5. Returned to grill-with-docs → 4 design questions answered (Q1-Q4)
6. CONTEXT.md updated; ADR-0006 created
7. to-issues skill → 6 vertical slices drafted, approved, published to GitHub
8. Session ends with Slice 1 partially implemented (migration + prompt done; response parsing remaining)