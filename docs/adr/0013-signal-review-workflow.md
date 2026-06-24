# Signal Review Workflow — Processing State Dropdown + Reviewed Flag

**Status:** Proposed  
**Issues:** #183 (Add `reviewed` flag to signals)  
**Date:** 2026-06-24

## Context

Issue #183 proposes adding a `reviewed` boolean flag to signals so the user can filter the signal list to show only unreviewed items. During grilling, additional requirements emerged: a dropdown on the Signal Detail page to change `processing_state`, and clarification on how `reviewed` interacts with existing state management.

## Decisions

### D1: Processing State — Keep 3 Existing States Only

The `processing_state` column on `signals` retains exactly three values:

| State | Meaning |
|-------|---------|
| `pending` | Signal received, not yet analyzed by LLM |
| `summarized` | LLM has produced summary + sentiment + entities |
| `irrelevant` | Manually marked as not worth reviewing (filtered from list) |

**No new states added.** No `flagged`, `archived`, or `error` states at this time.

### D2: `reviewed` Flag — Separate Column, Independent of `processing_state`

A new `reviewed INTEGER DEFAULT 0` column is added to `signals`. It is **orthogonal** to `processing_state`:

- A signal can be `processing_state = 'summarized'` AND `reviewed = 0` (analyzed but not yet opened by the user)
- A signal can be `processing_state = 'irrelevant'` AND `reviewed = 1` (user reviewed it and marked irrelevant)
- Changing `processing_state` does **not** automatically change `reviewed`

This separation allows independent queries: "show me signals I haven't looked at yet" (`reviewed = 0`) regardless of their processing state.

### D3: Irrelevant Signals — Hidden From List (Existing Behavior Preserved)

Signals with `processing_state = 'irrelevant'` remain hidden from the signal list by default, consistent with the existing "Show Irrelevant" toggle behavior. No visual distinction needed — they are simply excluded unless the user explicitly enables "Show Irrelevant".

### D4: Signal Detail Dropdown — All Transitions Allowed

A dropdown on the Signal Detail page lets users change `processing_state` freely. All transitions between the 3 states are permitted:

```
pending     ↔  summarized
pending     ↔  irrelevant
summarized  ↔  irrelevant
```

No guardrails or restrictions on which transitions are allowed. The user may change their mind at any point (e.g., mark `irrelevant` → `summarized`).

## UI Implications

1. **Signal Detail page** (`views/signal-detail.ejs`): Add a `<select>` dropdown showing current `processing_state` with options for all 3 states. On change, POST to an endpoint that updates `processing_state` and returns an HTMX OOB swap for instant UI feedback.

2. **Signal List page** (`views/signals.ejs` + `views/_signalsTable.ejs`): Add "Show Unreviewed" toggle filter (shows only `reviewed = 0` or `reviewed IS NULL`). Default view is unreviewed-only. Irrelevant signals remain hidden unless "Show Irrelevant" is toggled on.

3. **Visual indicator**: Small badge next to unreviewed signal titles in the list (e.g., unfilled circle or "UNREAD" label).

## Database Migration

```sql
ALTER TABLE signals ADD COLUMN reviewed INTEGER DEFAULT 0;
```

Existing signals get `reviewed = 0` by default.

## Consequences

- **Positive**: Independent tracking of review status allows filtering by "what have I not read yet?" regardless of processing state. Simple dropdown UX with full flexibility.
- **Negative**: Extra column adds minimal storage overhead. No automatic sync between `reviewed` and state transitions means the user must explicitly mark signals as reviewed (or the UI can auto-set it on any state change — decision pending implementation).
- **Trade-off**: Keeping `reviewed` separate from `processing_state` adds complexity but preserves semantic clarity: one tracks *system processing*, the other tracks *user attention*.

**Issues:** #183. https://github.com/timvangestel-coder/mtgnews/issues/183