# Group B Design Alignment — Deepening Opportunities

**Date:** 2026-07-07
**Status:** Approved — grilled 2026-07-07, decisions recorded in [ADR-0020](docs/adr/0020-group-b-alignment-decisions.md)
**Context:** Architecture review identified 6 deepening opportunities to align Admin Panel & Run History (Group B) with the modernized design principles from Signals, Signal Detail & Chat (Group A).

---

## Background

Group A (Signals list, Signal detail, Chat panel) was modernized per [ADR-0018](docs/adr/0018-ui-modernization-decisions.md) and [ADR-0019](docs/adr/0019-ui-modernization-grill-decisions.md) with the following design principles:

| Principle | Implementation |
|-----------|---------------|
| **DesignTokens** | Semantic color tokens (brand, success, warning, danger, muted, surface) via `tailwind-config.js` |
| **DarkModeModule** | Auto-detect + manual toggle; `dark:` variants on every element |
| **ZeroInlineStyles** | Hard rule — all styling via token classes or CSS custom properties |
| **KeyboardNav** | Roving tabindex, ARIA tablist, focus trap throughout |
| **ResponsiveBreakpoints** | Hamburger sidebar, scrollable pills, overlay chat on mobile |
| **MotionToken** | Unified 200ms transitions, spring easing for layout shifts |
| **Card Layouts** | `rounded-xl`, `shadow-card-md`, avatar + metadata chips pattern |
| **Underline Tabs** | ARIA tablist with arrow-key nav (ADR-0018 Decision 5) |
| **UiStateModule** | Centralized Alpine.js data functions in `ui-state.js` |

Group B (Admin Panel, Run History list + detail) has NOT been aligned. It still uses:
- Raw Tailwind colors: `bg-gray-50`, `text-gray-500`, `bg-green-600`, `bg-blue-100`
- No `dark:` variants on admin tab content
- Traditional HTML table layout for Run History (no card treatment)
- Pill-style tabs instead of underline tabs (inconsistent with Signal Detail)
- No ARIA attributes or keyboard navigation in admin tabs
- `admin-tabs.js` as standalone module (not part of UiStateModule pattern)
- Inline `onchange="this.form.requestSubmit()"` handlers (violates ZeroInlineStyles spirit)
- No responsive treatment for admin content on mobile

---

## Candidate #1: Tokenize Group B — Replace Raw Colors with DesignTokens

**Strength:** <span style="background:#dc2626;color:white;padding:2px 8px;border-radius:9999px;font-weight:bold">Strong</span>

### Files
- `views/admin/_channelsTab.ejs`
- `views/admin/_topicsTab.ejs`
- `views/admin/_pollingTab.ejs`
- `views/admin/_dataTab.ejs`
- `views/polls.ejs`
- `views/poll-detail.ejs`

### Problem
Group B uses raw Tailwind color classes (`bg-gray-50`, `text-gray-500`, `bg-green-600`, `bg-blue-100`) that bypass the DesignToken module. This creates visual inconsistency: Group A pages use semantic tokens (brand, success, danger) while Group B uses literal colors. Dark mode breaks because raw classes have no `dark:` variants.

### Solution
Systematic find-replace pass across all Group B view files, mapping raw colors to the nearest DesignToken equivalent. Every element receives a matching `dark:` variant.

**Migration map:**

| Current (Group B) | Replacement (tokenized) |
|-------------------|------------------------|
| `bg-gray-50` | `bg-surface-50 dark:bg-muted-900` |
| `text-gray-500` | `text-muted-500 dark:text-muted-400` |
| `bg-green-600` | `bg-success-600` |
| `text-green-700` | `text-success-700 dark:text-success-300` |
| `bg-blue-100 / text-blue-700` | `bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300` |
| `bg-blue-600 / text-blue-600` | `bg-brand-600 / text-brand-600 dark:text-brand-400` |
| `text-red-600` | `text-danger-600 dark:text-danger-400` |
| `bg-amber-100 / text-amber-700` | `bg-warning-100 dark:bg-warning-900 text-warning-700 dark:text-warning-300` |

### Benefits
- **Locality:** All color decisions flow through one config module (`tailwind-config.js`). Future palette changes touch one file, not twelve view files.
- **Leverage:** Dark mode works automatically on Group B pages because every token has a dark variant defined in the config.
- **Test surface:** E2E tests can verify dark mode on admin pages using the same selectors as signals pages — no separate test matrix needed.

---

## Candidate #2: Run History — Table to Card List Layout

**Strength:** <span style="background:#dc2626;color:white;padding:2px 8px;border-radius:9999px;font-weight:bold">Strong</span>

### Files
- `views/polls.ejs`
- `views/poll-detail.ejs`

### Problem
Run History uses a traditional HTML table layout, which is visually inconsistent with the card-list treatment in Group A's Signal Viewer (`_signalsTable.ejs`). The table has no dark mode variants and doesn't match the established visual language (rounded cards, shadow tokens, avatar-style indicators). This creates a jarring transition when navigating between Signals and Run History via the sidebar.

### Solution
Replace the table in `polls.ejs` with card-based rows matching the Signal List pattern: each run becomes a card with status badge, metadata chips, and click-to-detail behavior. The poll-detail page receives the same card container treatment as signal-detail.

**Card structure per run:**
```
┌─────────────────────────────────────────────────────┐
│  [✓]  Poll Run — Jul 6, 2026              [done]   │
│       3 channels · 5d lookback                      │
└─────────────────────────────────────────────────────┘
```

Status avatar: ✓ for done (green), ✗ for failed (red), ⏸ for done-forced (amber)
Card styling: `bg-white dark:bg-slate-800 rounded-xl border border-surface-200 dark:border-muted-700 p-3 cursor-pointer hover:shadow-card-md`

### Benefits
- **Locality:** One visual language across all four top-level pages. The card pattern becomes the default list container.
- **Leverage:** Mobile responsiveness comes for free — cards stack naturally on narrow screens, whereas tables require horizontal scroll wrappers.

---

## Candidate #3: Admin Tabs — Pill Buttons to Underline Tabs with ARIA

**Strength:** <span style="background:#f59e0b;color:black;padding:2px 8px;border-radius:9999px;font-weight:bold">Worth exploring</span>

### Files
- `views/admin.ejs`
- `views/scripts/admin-tabs.js`

### Problem
Admin uses pill-style tab buttons (`rounded-full bg-brand-600`) while Signal Detail uses underline tabs with full ARIA support (ADR-0018 Decision 5). The admin tabs lack `role="tablist"`, roving tabindex, and keyboard navigation. This violates the KeyboardNav principle established in Group A.

### Solution
Restyle admin tabs to match the underline-tab pattern from Signal Detail: `role="tablist"`, arrow-key navigation, `aria-selected`, `aria-controls`. The tab content panels already use `x-if` with `<template>` — no behavior change needed, only visual + ARIA updates.

**Before (pill buttons):**
```html
<button class="px-4 py-2 rounded-full bg-brand-600 text-white font-medium text-sm">Channels</button>
<button class="px-4 py-2 rounded-full bg-gray-200 text-gray-700 font-medium text-sm">Topics</button>
```

**After (underline tabs):**
```html
<div role="tablist" aria-label="Admin sections" class="flex gap-0 -mb-px border-b border-surface-200">
  <button role="tab" aria-selected="true" class="pb-3 px-2 text-sm font-semibold text-brand-600 border-b-2 border-brand-500">Channels</button>
  <button role="tab" aria-selected="false" class="pb-3 px-2 text-sm text-muted-500 hover:text-slate-700">Topics</button>
  ...
</div>
```

Keyboard handler added to `adminTabs()` for ArrowLeft/ArrowRight roving focus (matching the `detailTabs()` pattern in `ui-state.js`).

### Benefits
- **Locality:** One tab component pattern across the entire application. Future tab additions copy one recipe.
- **Leverage:** Screen reader support comes from ARIA attributes — no separate accessibility pass needed.

---

## Candidate #4: Admin Scripts → UiStateModule Consolidation

**Strength:** <span style="background:#f59e0b;color:black;padding:2px 8px;border-radius:9999px;font-weight:bold">Worth exploring</span>

### Files
- `views/scripts/admin-tabs.js`
- `views/scripts/admin-delete-modal.js`
- `views/scripts/ui-state.js`
- `views/layout.ejs` (script loading section)

### Problem
`admin-tabs.js` registers `window.adminTabs()` as a standalone module, while Group A uses the UiStateModule pattern (`window.UiState.filterBar()`, etc.). This creates two parallel conventions for Alpine.js data functions. The `admin-delete-modal.js` follows the same standalone pattern. The seam between "admin scripts" and "UI state scripts" is arbitrary — both are Alpine.js data factories.

**Before (scattered modules):**
```
admin-tabs.js        → window.adminTabs()
admin-delete-modal.js → window.deleteModal()
ui-state.js          → window.UiState.filterBar(), .signalListView(), ...
```

**After (unified UiStateModule):**
```
ui-state.js → window.UiState.adminTabs()
            → window.UiState.deleteModal()
            → window.UiState.filterBar()
            → window.UiState.signalListView()
            → window.UiState.detailTabs()
```

### Solution
Move `adminTabs()` and `deleteModal()` into the UiStateModule namespace as `window.UiState.adminTabs()` and `window.UiState.deleteModal()`. Consolidate script loading in `layout.ejs` to a single `ui-state.js` load for all pages. Update template references: `x-data="adminTabs()"` → `x-data="UiState.adminTabs()"`, `x-data="deleteModal()"` → `x-data="UiState.deleteModal()"`.

The admin-specific HTMX processing logic (e.g., `htmx.process($el)` in tab init) stays inline — it's the adapter layer, not the interface.

### Benefits
- **Locality:** All Alpine.js data factories live in one module. New developers find them in one place.
- **Leverage:** The UiStateModule becomes the single test surface for client-side state logic — unit tests target one file rather than three scattered scripts.

---

## Candidate #5: Admin Channels — Card Layout Matching Group A Pattern

**Strength:** <span style="background:#f59e0b;color:black;padding:2px 8px;border-radius:9999px;font-weight:bold">Worth exploring</span>

### Files
- `views/admin/_channelsTab.ejs`

### Problem
The WatchList cards in `_channelsTab.ejs` use `bg-gray-50 rounded` with raw color classes, inline `onchange="this.form.requestSubmit()"` handlers, and no dark mode variants. The channel avatar uses a generic gray circle (`rounded-full bg-gray-300`) instead of the brand-colored avatar pattern from Group A's Signal List cards (`rounded-lg bg-brand-100`).

### Solution
Apply the Group A card pattern to each WatchList row:

**Card container:** `bg-white dark:bg-slate-800 rounded-xl border border-surface-200 dark:border-muted-700 p-3`
**Avatar:** `w-10 h-10 rounded-lg bg-brand-100 dark:bg-brand-900 text-brand-600 dark:text-brand-300 flex items-center justify-center font-semibold text-sm`
**Topic badge:** `px-2 py-0.5 bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300 rounded-full text-xs font-medium`

Replace inline `onchange="this.form.requestSubmit()"` with Alpine.js event dispatch pattern (consistent with ZeroInlineStyles principle):
```html
<!-- Before: inline handler -->
<select name="topic_id" onchange="this.form.requestSubmit()">

<!-- After: Alpine dispatch -->
<select name="topic_id" @change="$dispatch('admin-topic-change', { channelId: '...', topicId: $event.target.value })">
```

### Benefits
- **Locality:** Card styling is one pattern, not two. The "channel card" visual language is consistent whether viewed in Signals or Admin.
- **Leverage:** Inline handler removal follows the ZeroInlineStyles principle — behavior lives in extractable JS modules rather than scattered EJS attributes.

---

## Candidate #6: Responsive Admin — Mobile Breakpoints for Group B

**Strength:** <span style="background:#6366f1;color:white;padding:2px 8px;border-radius:9999px;font-weight:bold">Speculative</span>

### Files
- `views/admin.ejs`
- `views/polls.ejs`
- `views/admin/_channelsTab.ejs`

### Problem
Group A has full ResponsiveBreakpoints (ADR-0019 Decision 6): hamburger sidebar, scrollable filter pills, overlay chat on mobile. Group B pages have no responsive treatment — the admin tab row overflows horizontally on narrow screens, and the channel cards don't stack properly.

### Solution
Apply the same breakpoint strategy from Group A:

**Admin tabs:** `flex-wrap md:flex-nowrap` so tabs wrap on mobile but stay in a row on desktop.
**Channel cards:** Already flex-column (stack vertically naturally). Add responsive gaps: `gap-3 md:gap-4`.
**Run history cards:** Adapt to narrow widths — metadata chips wrap, status badge stays right-aligned.
**Add Channel form:** Stack inputs vertically on mobile (`flex-col md:flex-row`), horizontal row on desktop.

The sidebar drawer is already shared via `layout.ejs` (hamburger menu + slide-out drawer at `< md`) — only page content needs responsive classes.

### Benefits
- **Locality:** One responsive strategy across all pages. The breakpoint vocabulary (`md:`, `lg:`) is consistent.

---

## Suggested Implementation Order

```
#1 Tokenize Group B
  ↓
#2 Run History cards + #5 Admin Channel cards (parallel)
  ↓
#3 Admin Tabs → underline tabs + ARIA
  ↓
#4 UiStateModule consolidation
  ↓
#6 Responsive Admin
```

**Rationale:** Candidate #1 is a pure find-replace pass with zero behavior change but unlocks dark mode on all Group B pages immediately. After tokens are in place, Candidates #2 and #5 become mechanical — the visual target is already established by Group A's card pattern. Candidate #3 follows naturally since tokenized colors make tab restyling trivial. Candidate #4 consolidates the JS layer after the template changes are done. Candidate #6 is lower priority (speculative) but straightforward once cards are in place.

---

## Questions for Grilling

1. **Scope boundary:** Should Admin [Data] tab (`_dataTab.ejs`) be included in tokenization, or is it internal-only and can skip alignment?
2. **Admin form inputs:** The Add Channel form and topic edit forms use `border rounded focus:ring-blue-500`. Should these ring colors use `focus:ring-brand-500` consistently?
3. **Progress widget:** `_pollProgress.ejs` uses color-coded channel states (blue/green/grey/red). Do these already use tokens, or do they also need tokenization?
4. **Card vs table for Run History:** Is there a data density concern? Tables show more data per screen height. Cards require scrolling but are mobile-friendly. Hybrid approach possible?
5. **UiStateModule consolidation timing:** Should #4 happen before or after the template changes (#1-#3)? Doing it first reduces per-candidate diff size but requires updating references in multiple files at once.
6. **Inline handler removal in Admin:** How aggressive should we be? The `onchange="this.form.requestSubmit()"` pattern is concise and clear. Is the ZeroInlineStyles principle worth replacing it with a more verbose Alpine dispatch for admin-only forms?