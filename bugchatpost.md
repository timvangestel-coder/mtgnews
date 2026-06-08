# Chat 500 Error Diagnosis — Summary (UPDATED)

## Problem Statement
When asking a question in the chat on the signal detail page, the user receives:
```json
{"error":"Failed to enqueue question"}
```
HTTP 500 status.

---

## Root Cause (CONFIRMED via live server probe)

**Schema mismatch**: The production `signal_chat` table was created with `answer TEXT NOT NULL`, but the code inserts `NULL` for pending answers during async two-phase processing. SQLite rejects the INSERT with:

```
SqliteError: NOT NULL constraint failed: signal_chat.answer
```

The `CREATE TABLE IF NOT EXISTS` in `init-db.ts` never fires because the table already exists, so the corrected schema (`answer TEXT` — nullable) is never applied to existing databases.

---

## Diagnosis Process

### Phase 1 — Feedback Loop (Direct server probe)
- Created Node.js fetch script that POSTs to `http://localhost:3000/chat/ask`
- Bypassed shell escaping issues by using native `fetch()` API

### Phase 2 — Reproduce
- **REAL signal** → HTTP 500 ✅ (bug confirmed)
- **FAKE signal** → HTTP 404 ✅ (correct behavior, eliminates "not found" path)
- **Empty question** → HTTP 400 ✅ (validation works)

### Phase 3 — Hypotheses (ranked)
1. **H1 (CONFIRMED): Schema mismatch — NOT NULL constraint on answer column** ⭐
   - Prediction: Leaking error details in response will show SqliteError about NOT NULL
2. H2 (Ruled out): BigInt serialization in lastInsertRowid
   - The `Number(id)` fix was already applied but didn't help
3. H3 (Ruled out): Signal not found
   - Fake signal returns 404, real signal returns 500 — different paths

### Phase 4 — Instrument
- Added temporary debug fields (`_debug`, `_stack`) to error response
- **Result:** `SqliteError: NOT NULL constraint failed: signal_chat.answer`
- Verified actual DB schema using `better-sqlite3` directly:
  ```
  answer: type=TEXT, notnull=1, default=null  ← WRONG (should be notnull=0)
  ```

### Phase 5 — Fix Applied

#### Fix: `src/db/init-db.ts` — Migration to recreate table with nullable answer
```typescript
// Issue #120: Migration — fix answer column to be nullable for async processing
const chatRows = db.pragma('table_info(signal_chat)') as Array<{ name: string; notnull: number }>;
const answerCol = chatRows.find((r) => r.name === 'answer');
if (answerCol && answerCol.notnull === 1) {
  // Recreate table with nullable answer column
  db.exec('ALTER TABLE signal_chat RENAME TO signal_chat_old');
  db.exec(`CREATE TABLE signal_chat (...)`);  // answer TEXT (nullable)
  db.exec('INSERT INTO signal_chat ... SELECT ... FROM signal_chat_old');
  db.exec('DROP TABLE signal_chat_old');
}
```

SQLite cannot ALTER COLUMN to remove NOT NULL, so the table is recreated with data migration.

#### Previous fix retained: `src/routes/chat-router.ts` line 24
```typescript
res.json({ id: Number(id), status: 'pending' });
```
The `Number()` conversion for BigInt safety remains as defensive coding.

### Phase 6 — Verification

- **Live server probe:** HTTP 200, response: `{"id":1,"status":"pending"}` ✅
- **Schema verified:** `answer: type=TEXT, notnull=0` ✅
- **All 532 tests pass** (42 test files) ✅

### Phase 6 — Cleanup ✅ Complete
- [x] Removed debug fields (`_debug`, `_stack`) from error response
- [x] Removed all temporary probe scripts
- [x] Kept `src/chat-enqueue-500.test.ts` as permanent regression test (6 tests)

---

## Why the Initial Diagnosis Was Wrong

The original bugchatpost.md diagnosed BigInt serialization as the root cause. While the `Number(id)` fix was a valid defensive improvement, it did NOT address the actual error. The real cause was a **schema migration gap**: the production database had an older table definition with `answer TEXT NOT NULL` that was never updated when the code changed to use two-phase async processing (insert pending row with answer=NULL, then UPDATE when LLM responds).

The key insight: `CREATE TABLE IF NOT EXISTS` only creates new tables — it never alters existing ones. When column constraints change, explicit migrations are required.