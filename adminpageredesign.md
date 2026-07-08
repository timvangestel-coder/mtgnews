# Admin Panel UX Redesign

**Date:** 2026-07-08
**Status:** Grilled — ready for implementation
**Grilling session:** 2026-07-08

---

## Approved Design Decisions

| Decision | Outcome |
|---|---|
| Tab bar | **Overview \| Channels \| Topics \| Settings** (4 tabs) |
| Polling tab | Merged into Overview — no separate Polling tab |
| Data tab | Merged into Settings as Danger Zone — no separate Data tab |
| Overview default | Yes — Overview is the default landing tab |
| Overview: layout order | Status counts → Run Poll trigger → Progress widget → Run history |
| Overview: counts | Channels (active), Topics, Signals (summarized), Pending |
| Overview: run history | Last 5 runs, each links to `/polls/:id` |
| Overview: progress widget | Conditional — only shown when a run is active |
| Settings content | Global Default Summary Prompt + Danger Zone (soft-delete undo/purge) |
| Settings tab name | "Settings" |
| chat_response_format | Not exposed in UI — dropped from scope |
| Topics: editing | Centered `max-w-2xl` modal, single component for Add and Edit |
| Topics: table | 4 columns only: Key, Short Name, Channels, Actions |
| Topics: Global Default Prompt | Moves out of Topics tab into Settings tab |
| Channels: Add form | Collapsible section; auto-opens when WatchList is empty |
| Candidate 6 (two-column layout) | Dropped — collapsible form solves the same problem |

---

## UX + Dark Mode Wiring (reference)

| Layer | Current setup |
|---|---|
| **Dark mode** | `DarkMode` module (`views/scripts/dark-mode.js`) — auto-detects `prefers-color-scheme`, toggles `<html class="dark">`, persists to `localStorage["mtgnews-dark"]`. Sun/moon button in sidebar footer. |
| **Design tokens** | `tailwind-config.js` — six families (`brand`, `success`, `warning`, `danger`, `muted`, `surface`), each 50-900. `darkMode: 'class'` — every element needs explicit `dark:` variants. |
| **Admin tab state** | `UiState.adminTabs()` in `ui-state.js` — manages `activeTab`, keyboard roving focus, fetches tab content via `fetch()` to `/admin/:key-fragment` endpoints. |
| **Tab fragments** | Each tab is an independent HTMX fragment. Mutations emit `HX-Trigger` events; tab wrappers respond via `hx-trigger="refreshXxx from:body"`. |
| **Responsiveness** | Hamburger sidebar on `< md`. Admin tab content stacks vertically at full width on all breakpoints. |

---

## Parent Issue

### What to build

Redesign the Admin Panel (`/admin`) across all tabs for improved UX: logical information hierarchy, progressive disclosure for infrequently-used forms, and a dashboard-first Overview tab.

The four tabs change from `Channels | Topics | Polling | Data` to `Overview | Channels | Topics | Settings`:

- **Overview** (new default): system status counts + Run Poll trigger + live progress + last 5 runs. Absorbs the Polling tab entirely.
- **Channels**: existing WatchList cards with a collapsible Add Channel form (hidden by default, auto-opens on empty list).
- **Topics**: slim 4-column table (Key, Short Name, Channels, Actions). Add and Edit both open a centred `max-w-2xl` modal — no more inline expanding rows.
- **Settings** (replaces Data): Global Default Summary Prompt editor + Danger Zone for soft-delete management.

### Acceptance criteria

- [ ] Tab bar reads: Overview | Channels | Topics | Settings
- [ ] Overview is the default landing tab (`data-admin-default-tab="overview"`)
- [ ] Overview shows 4 count chips: active Channels, Topics, summarized Signals, Pending signals
- [ ] Overview shows Run Poll trigger form (lookback days + button)
- [ ] Progress widget appears only when a run is active; hidden at rest
- [ ] Overview shows last 5 poll runs with status icons and links to `/polls/:id`
- [ ] Channels Add Channel form is collapsed by default; auto-opens when WatchList is empty
- [ ] Topics table has exactly 4 columns: Key, Short Name, Channels, Actions
- [ ] Clicking Add Topic opens a centred modal (empty fields)
- [ ] Clicking Edit on a topic row opens the same modal pre-filled
- [ ] Modal submits via HTMX, closes on success, fires `refreshTopics` event
- [ ] Settings tab contains Global Default Summary Prompt editor
- [ ] Settings tab contains Danger Zone (soft-delete Undo All / Purge All) formerly in Data tab
- [ ] All new tab content uses DesignTokens and `dark:` variants throughout
- [ ] `CONTEXT.md` updated: `[Polling] tab` references changed to `[Overview] tab`
- [ ] Keyboard navigation works on all new tab content (focus trap in modal: trap on open, restore on close)

### Blocked by

None — implement via the 4 sub-slices below

---

## Sub-Issue 1 — Channels tab: collapsible Add Channel form

### Parent

Admin Panel UX Redesign (see above)

### What to build

Wrap the existing Add Channel form in a collapsible section. The form is hidden by default. A `+ Add Channel` button in the section header toggles it open. When the WatchList is empty (zero channels), the form starts open as an empty-state nudge.

No route or data changes needed — template + Alpine state change only.

```
Channels  [ + Add Channel ]
----------------------------------------------
[✓] MrBeast   MTG   Active   ...
[✓] LSV       MTG   Active   ...
```

On `+ Add Channel` click:

```
Channels  [ + Add Channel (open) ]
----------------------------------------------
[ Channel ID input ]  [ Topic select ]  [ Add ]
----------------------------------------------
[✓] MrBeast   MTG   Active   ...
```

### Acceptance criteria

- [ ] Add Channel form is hidden on page load when channels exist
- [ ] Clicking `+ Add Channel` reveals the form with a smooth transition (`x-collapse` or `x-transition`)
- [ ] Clicking the button again collapses the form
- [ ] When `channels.length === 0`, form starts expanded with empty-state message below
- [ ] Button label/icon reflects open/closed state
- [ ] All new elements use `dark:` variants
- [ ] E2E test: form hidden on load (with channels); toggles open on click; auto-open on empty watchlist

### Blocked by

None — can start immediately

---

## Sub-Issue 2 — Topics tab: centered modal for Add/Edit + slim table

### Parent

Admin Panel UX Redesign (see above)

### What to build

Replace the inline expanding-row edit mechanism in `_topicRow.ejs` with a centred `max-w-2xl` modal. Both Add and Edit use the same modal component — title and submit URL change between modes.

The Topics table shrinks to 4 columns. The three truncated text columns (Filter Text, Summary Prompt, Multi-Signal Prompt) are removed from the table — they live in the modal where there is space.

The Global Default Prompt section stays in the Topics tab temporarily until Sub-Issue 3 lands.

**Table (read-only):**

| Key | Short Name | Channels | Actions |
|---|---|---|---|
| `mtg` | MTG | 6 | Edit · Delete |

**Modal add mode:**
- Title: "Add Topic"
- Fields: Key, Short Name, Filter Text, Summary Prompt (optional), Multi-Signal Summary Prompt (optional)
- Submit: `hx-post="/admin/topics"` — on success: close modal + emit `refreshTopics`

**Modal edit mode:**
- Title: "Edit: {short_name}"
- Fields pre-filled from topic data attributes on the row
- Submit: `hx-patch="/admin/topics/:id"` — on success: close modal + emit `refreshTopics`

Modal closes on: Save (success), Cancel button, Escape key, backdrop click.
Focus trap: focus moves into modal on open, returns to triggering button on close.

New Alpine component `UiState.topicModal()` in `ui-state.js`:
- `open: false`, `mode: 'add' | 'edit'`, `topic: {}`
- `openAdd()`, `openEdit(topic)`, `close()`

### Acceptance criteria

- [ ] Topics table shows exactly 4 columns: Key, Short Name, Channels, Actions
- [ ] No inline edit inputs or textareas remain in `_topicRow.ejs`
- [ ] `+ Add Topic` button opens modal in add mode (empty fields)
- [ ] `Edit` button on a topic row opens modal in edit mode (pre-filled)
- [ ] Modal title reflects mode: "Add Topic" vs "Edit: {short_name}"
- [ ] Summary Prompt and Multi-Signal Prompt fields show placeholder "(using default)" when empty
- [ ] Successful add reloads the Topics table via `refreshTopics` event and closes modal
- [ ] Successful edit reloads the Topics table via `refreshTopics` event and closes modal
- [ ] Modal closes on Cancel, Escape key, and backdrop click
- [ ] Focus is trapped inside modal while open; returns to trigger button on close
- [ ] `UiState.topicModal()` exported from `ui-state.js`
- [ ] All modal elements use `dark:` variants
- [ ] E2E test: add topic via modal; edit topic via modal; cancel discards changes

### Blocked by

None — can start immediately (Global Default Prompt stays in Topics until Sub-Issue 3)

---

## Sub-Issue 3 — Settings tab: replaces Data tab

### Parent

Admin Panel UX Redesign (see above)

### What to build

Add a new **Settings** tab that absorbs two responsibilities currently scattered across other tabs:

1. **Global Default Summary Prompt** — currently at the top of the Topics tab. Moves here. Remove the section from `_topicsTab.ejs` once Settings is live.
2. **Danger Zone** — the soft-delete Undo All / Purge All panel from `_dataTab.ejs`. Moved here as a visually distinct section with a warning header.

Replace the "Data" tab button in `admin.ejs` with "Settings". Retire `_dataTab.ejs`.

**Settings tab layout:**

```
LLM Settings
----------------------------------------------
Global Default Summary Prompt:
[ textarea ]   [ Save ]
Status: "Using compiled default" / "Custom override active"

----------------------------------------------
Danger Zone
----------------------------------------------
Soft-deleted entities:  0 Channels  0 Signals  ...

[ Undo All ]   [ Purge All ]   (disabled when total = 0)
```

New fragment endpoint: `GET /admin/settings-fragment`
New partial: `views/admin/_settingsTab.ejs`
Add `{ key: 'settings', partial: '_settingsTab', dataFn: settingsData }` to `TABS[]` in `admin-tab-fragments.ts`.
`settingsData` fetches: `getAppSetting(db, 'default_summary_prompt')` + soft-delete counts (same query as current data fragment).

### Acceptance criteria

- [ ] "Data" tab button replaced by "Settings" in `admin.ejs` tab nav
- [ ] `GET /admin/settings-fragment` returns the Settings tab content
- [ ] Settings tab shows Global Default Summary Prompt textarea with save/clear behaviour matching current Topics tab implementation
- [ ] Settings tab shows soft-delete counts and Undo All / Purge All buttons (same behaviour as current Data tab)
- [ ] Undo All and Purge All are disabled when `softDeleteTotal === 0`
- [ ] Danger Zone section is visually distinct (warning colour header, e.g. `text-warning-700 dark:text-warning-400`)
- [ ] Global Default Prompt section removed from `_topicsTab.ejs`
- [ ] `_dataTab.ejs` retired (deleted or left as empty stub)
- [ ] All elements use `dark:` variants
- [ ] E2E test: navigate to Settings; save prompt; verify saved; navigate back; verify persisted; purge button disabled when no soft-deleted rows

### Blocked by

Sub-Issue 2 — ensures Global Default Prompt section is removed from Topics cleanly after the modal lands, avoiding a period where the prompt editor appears in both tabs simultaneously

---

## Sub-Issue 4 — Overview tab: replaces Polling tab

### Parent

Admin Panel UX Redesign (see above)

### What to build

Add a new **Overview** tab as the default admin landing tab. It absorbs the Polling tab entirely: the Run Poll trigger form and live progress widget move here, joined by system status counts and a mini run history.

Replace the "Polling" tab button in `admin.ejs` with "Overview". Set `data-admin-default-tab="overview"`. Retire `_pollingTab.ejs`.

**Overview tab layout (top to bottom):**

```
[ Channels: 6 ]  [ Topics: 2 ]  [ Signals: 128 ]  [ Pending: 0 ]

Run Poll Now
Lookback: [2] days   [ Run Poll Now ]

-- (progress widget -- only shown when state.status === 'running') --

Recent Runs
-----------------------------------------------------------------
[✓]  Jul 8, 2026  3 ch · 5 signals                        done
[✓]  Jul 7, 2026  3 ch · 2 signals                        done
[⏸]  Jul 6, 2026  aborted                              aborted
[✗]  Jul 5, 2026  failed                                 failed
[✓]  Jul 4, 2026  3 ch · 0 signals                        done

[ View all runs → ]
```

**Status count chips:** active channels (non-null `topic_id`), topic count, summarized signal count, pending signal count. Pending chip uses `text-warning-*` when non-zero.

**Progress widget:** reuse `_pollProgress.ejs` partial. Render only when `state && state.status === 'running'`. When poll is triggered (HTMX swap), the widget appears. When run completes, fragment refreshes and widget disappears.

**Mini run history:** last 5 rows from `poll_runs` ordered by `started_at DESC`. Status icons: ✓ (`done`), ✗ (`failed`), ⏸ (`done-forced`). Each row links to `/polls/:id`.

**CONTEXT.md update:** replace all `[Polling] tab` references with `[Overview] tab` in Poll Run UI State and related entries.

New fragment endpoint: `GET /admin/overview-fragment`
New partial: `views/admin/_overviewTab.ejs`
Add `{ key: 'overview', partial: '_overviewTab', dataFn: overviewData }` to `TABS[]` in `admin-tab-fragments.ts`.
`overviewData` fetches: channel count, topic count, signal counts by `processing_state`, last 5 poll runs, current run state.
Update `UiState.adminTabs()` `TAB_ORDER` to `['overview', 'channels', 'topics', 'settings']`.

### Acceptance criteria

- [ ] "Polling" tab button replaced by "Overview" in `admin.ejs` tab nav
- [ ] Overview is the default tab (`data-admin-default-tab="overview"`)
- [ ] `GET /admin/overview-fragment` returns the Overview tab content
- [ ] 4 count chips displayed: active Channels, Topics, summarized Signals, Pending
- [ ] Pending chip uses warning colour when value > 0
- [ ] Run Poll Now form present with lookback days input and submit button
- [ ] Triggering a poll renders the progress widget in the Overview tab
- [ ] Progress widget is absent when no run is active
- [ ] Last 5 poll runs shown with status icon, date, channel count, signal count, and link to detail
- [ ] "View all runs →" link to `/polls`
- [ ] `_pollingTab.ejs` retired
- [ ] `UiState.adminTabs()` TAB_ORDER updated to `['overview', 'channels', 'topics', 'settings']`
- [ ] `CONTEXT.md` updated: `[Polling] tab` replaced with `[Overview] tab` in all occurrences
- [ ] All elements use `dark:` variants
- [ ] E2E test: Overview is default on `/admin`; counts match seed data; trigger poll shows progress widget; mini history shows seeded runs

### Blocked by

None — can start immediately
