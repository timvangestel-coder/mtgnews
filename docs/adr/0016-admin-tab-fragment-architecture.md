# ADR-0016: Admin Tab Fragment Architecture with HX-Trigger Event Bus

**Date:** 2026-06-29  
**Status:** Accepted  
**Issues:** #192, #193, #194, #195

## Context

The Admin Panel has four tabs ([Channels], [Topics], [Polling], [Data]) managed by Alpine.js tab state. Before this decision, mutation actions (channel add/remove, undo-all, purge-all) used `HX-Redirect` for full page reloads to refresh data across tabs. The DeleteModal had hardcoded DOM selectors and URL string matching (`isFragmentAction`) to branch between fragment swap and full reload — a fragile coupling between client-side JS and server route paths.

The Data tab was the only tab with a fragment endpoint (`GET /admin/data-fragment`). Channels, Topics, and Polling tabs were inline EJS inside `admin.ejs` with no independent refresh capability. Cross-tab invalidation (e.g., "Undo All" on Data tab should resurrect channels visible in Channels tab) required a full page reload.

## Decision

Each admin tab is an independently refreshable HTMX fragment driven by a config-driven router module, with cross-tab invalidation handled via server-emitted `HX-Trigger` events that tab wrappers listen for declaratively.

### Fragment Router Module (`src/routes/admin-tab-fragments.ts`)

A deep module with a static `TABS[]` config array defining each tab's `{ key, partial, dataFn }`. The `createFragmentRouter(deps)` factory registers `GET /admin/:key-fragment` routes that render the corresponding EJS partial with `layout: false`. Adding a 5th tab = one file edit (add to `TABS[]`).

Tab content extracted to partials: `_channelsTab.ejs`, `_topicsTab.ejs`, `_pollingTab.ejs` (`_dataTab.ejs` already existed).

### HX-Trigger Event Bus (Named Events)

Mutation endpoints emit named events via `HX-Trigger` header instead of `HX-Redirect`:
```typescript
res.set('HX-Trigger', JSON.stringify({ refreshChannels: {} }));
```

Each tab wrapper declares its event listener using pure HTMX attributes:
```html
<div id="channels-tab-content"
     hx-trigger="refreshChannels from:body"
     hx-get="/admin/channels-fragment"
     hx-target="#channels-tab-content"
     hx-swap="innerHTML">
```

Named events per tab (`refreshChannels`, `refreshTopics`, `refreshPolling`, `refreshData`) — not a generic event with payload filtering. HTMX routes natively, zero custom JS needed.

### DeleteModal Deepening

The modal stays with vanilla `fetch()` but reads the `HX-Trigger` header manually, then dispatches matching events on `document.body`. The modal touches zero DOM elements — it's a pure POST dispatcher: fire → read headers → dispatch events → close. Tab wrappers handle their own refresh via HTMX event listeners.

```javascript
const triggers = JSON.parse(response.headers.get('HX-Trigger') || '{}');
for (const [name, payload] of Object.entries(triggers)) {
  document.body.dispatchEvent(new CustomEvent(name, { detail: payload }));
}
this.open = false; // close modal
```

### No Abstraction for HX-Trigger Header Setting

Setting `HX-Trigger` is a single `res.set()` call — no wrapper function in `htmx-response.ts`. The current `htmxNoContent` utility stays for toggle/update actions that still use inline visual updates.

## Considered Options

| Option | Rejected Because |
|--------|-----------------|
| **Alpine.js listener** on tab wrappers | Adds framework coupling where HTMX attributes suffice. Alpine component would just forward an event to an HTMX call — shallow layer. |
| **Generic `tabRefresh` event with payload filtering** | Requires custom JS filtering since HTMX's `hx-trigger` can't inspect event payload properties. Named events are one-liners with zero custom code. |
| **Hidden HTMX form in modal** (instead of fetch) | Modal already uses fetch. Introducing a hidden form adds DOM complexity for no gain — the manual header read is one line. |
| **Modal swaps Data tab fragment itself** | Keeps hard seam between modal and Data tab DOM. Making modal action-agnostic (zero DOM knowledge) is deeper. One extra HTTP request is the price of decoupling. |
| **Per-tab dependency list in config** | Adds indirection without benefit — TypeScript catches unused deps, and `server.ts` doesn't need to know about individual tabs. |
| **Config passed from server.ts** | Scatters tab definitions across two files. The config *is* the interface surface of this deep module — locality matters. |
| **Incremental extraction (Channels first)** | Creates architectural inconsistency: two tabs with fragments, two without. Future readers ask "why these two?" Pattern applied completely or not at all. |

## Consequences

### Positive
- Cross-tab invalidation is decoupled: server declares *what* changed, tab wrappers own *how* to refresh
- DeleteModal is action-agnostic (no URL string matching, no hardcoded DOM selectors)
- Adding a 5th tab = one file edit (`TABS[]` array + partial + wrapper div)
- Zero custom JavaScript for event routing — HTMX handles it declaratively
- No full page reloads after mutations — fragment refreshes are faster and preserve scroll/tab state

### Negative
- One extra HTTP request per mutation (tab fetches its own fragment after hearing the event, instead of receiving HTML in the original response)
- `hx-trigger` on Alpine `<template x-if>` content requires `x-init="htmx.process($el)"` — a known gotcha already documented in CONTEXT.md

### Neutral
- All 4 tabs extracted symmetrically (not incremental) — consistent pattern from day one
- Toggle/update-topic actions unchanged (still use inline visual updates, no fragment refresh needed)