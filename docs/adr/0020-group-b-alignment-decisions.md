# ADR-0020: Group B Alignment — Grilling Decisions

**Date:** 2026-07-07
**Status:** Accepted
**Context:** Grilling session through `groupbdesign.md` identifying 6 deepening opportunities to align Admin Panel & Run History (Group B) with the modernized design principles from Signals, Signal Detail & Chat (Group A). Builds on [ADR-0018](0018-ui-modernization-decisions.md) and [ADR-0019](0019-ui-modernization-grill-decisions.md).

---

## Decision 1: _dataTab.ejs Included in Tokenization (Candidate #1 scope)

**Option chosen:** Include `_dataTab.ejs` in the Candidate #1 color tokenization pass.

**Rationale:** The file is small (67 lines) — tokenization takes seconds with find-replace. Excluding it creates a dark mode gap: raw colors won't adapt when the user toggles dark mode while on [Data], creating visual inconsistency against tokenized tabs/navigation. The table layout for count data stays as-is — no card conversion needed, just color tokens.

---

## Decision 2: Brand Tokens for Admin Form Focus Rings (Candidate #1 detail)

**Option chosen:** Replace `focus:ring-blue-500` and `peer-focus:ring-blue-300` with `focus:ring-brand-500` and `peer-focus:ring-brand-300` consistently across all admin forms.

**Rationale:** Focus indicators must match the brand palette across all pages. If someone changes the brand color in config, admin forms adapt automatically. This is part of the Candidate #1 tokenization pass.

---

## Decision 3: Poll Progress Widget Tokenized (Candidate #1 extension)

**Option chosen:** Tokenize `_pollProgress.ejs` as part of Candidate #1.

**Rationale:** The widget is shared between `_pollingTab.ejs` and `poll-detail.ejs`, so tokenizing it benefits both pages. Color semantics map cleanly onto existing DesignToken vocabulary:

| Current | Replacement |
|---------|-------------|
| `text-blue-600` (fetching/processing) | `text-brand-600 dark:text-brand-400` |
| `text-green-600` (done/complete) | `text-success-600 dark:text-success-400` |
| `text-red-600` (failed/error) | `text-danger-600 dark:text-danger-400` |
| `text-amber-600` (running/aborted/partial) | `text-warning-600 dark:text-warning-400` |
| `bg-red-50`, `border-red-200` (error alert) | `bg-danger-50 dark:bg-danger-900 border-danger-200 dark:border-danger-800` |

---

## Decision 4: Run History — Convert Table to Card List (Candidate #2)

**Option chosen:** Convert the table layout in `polls.ejs` to card-based rows matching Group A's signal list pattern.

**Rationale:** Full visual alignment with Group A is preferred over data density. Cards stack naturally on narrow screens, eliminating the need for `overflow-x-auto` wrappers. The density trade-off (fewer runs visible per screen) is accepted in favor of a single visual language across all four top-level pages.

**Card structure per run:**
```
+----------------------------------------------------------+
|  [status avatar]  Run #N — Jul 6, 2025          [badge] |
|                  3 channels · 5d lookback · X signals    |
+----------------------------------------------------------+
```

Status avatar: check for done (green), x-mark for failed (red), pause for done-forced (amber)
Card styling: `bg-white dark:bg-slate-800 rounded-xl border border-surface-200 dark:border-muted-700 p-3 cursor-pointer hover:shadow-card-md`

---

## Decision 5: UiStateModule Consolidation Timing (Candidate #4 ordering)

**Option chosen:** Option A — Consolidate AFTER template changes (#1-#3 done first).

**Rationale:**
- The consolidation is a mechanical rename (`adminTabs()` -> `UiState.adminTabs()`) with zero behavior change. Doing it last means the risky part (updating x-data references across multiple templates) happens once, not spread across candidates.
- Each visual candidate (#1 tokenization, #2 cards, #3 underline tabs) can be reviewed and verified independently before touching the JS layer.
- The admin-tabs.js file has HTMX-specific logic (`htmx.process($el)`) that's an adapter detail — keeping it separate until the template changes are stable reduces merge conflict risk.

---

## Decision 6: Inline Handler Removal via hx-trigger (Candidate #5 detail)

**Option chosen:** Option B — Replace `onchange="this.form.requestSubmit()"` with HTMX `hx-trigger="change from:input"`.

**Rationale:**
- Removes inline handlers with zero new JS code or Alpine dispatch overhead.
- Keeps behavior co-located in the template (the form tag already has all the HTMX config).
- Cleaner than full Alpine dispatch (no dispatch -> listener round-trip) and more principled than keeping inline JS (zero inline scripts).

**Affected locations:** `_channelsTab.ejs` lines 54 (active toggle), 71 (topic select).

---

## Implementation Order (confirmed)

```
#1 Tokenize Group B (includes _dataTab.ejs + _pollProgress.ejs + focus rings)
  ↓
#2 Run History cards + #5 Admin Channel cards (parallel)
  ↓
#3 Admin Tabs -> underline tabs + ARIA
  ↓
#4 UiStateModule consolidation
  ↓
#6 Responsive Admin
```

---

## Glossary Additions for CONTEXT.md

The following terms should be added to the CONTEXT.md glossary:

| Term | Definition |
|------|-----------|
| **Group A** | Signals list, Signal detail, Chat panel — modernized per ADR-0018/0019 with DesignTokens, dark mode, card layouts, underline tabs, UiStateModule pattern |
| **Group B** | Admin Panel (Channels/Topics/Polling/Data tabs), Run History list + detail — pending alignment with Group A design principles per ADR-0020 |
| **DesignToken** | Semantic color tokens (brand, success, warning, danger, muted, surface) defined in `tailwind-config.js`. Replaces raw Tailwind colors to enable dark mode and palette-wide changes from a single config file. |
| **UiStateModule** | Single JS module (`views/scripts/ui-state.js`) exposing all Alpine.js data factories as `window.UiState.*()`. Replaces scattered standalone modules (admin-tabs.js, admin-delete-modal.js). See ADR-0020 Decision 5. |