# Extra UI Requirements — Architecture Review Candidates

Generated from architecture review (`%TEMP%/ui-architecture-review-20260706.html`) on 2026-07-06. These are deepening opportunities beyond the 7-candidate modernization plan (issues #199–#205). Each candidate includes enough detail to grill through before merging into existing issues.

---

## C8: DesignToken Module — Beyond Colors (Strong)

**Blocks:** Nothing (Phase 0 foundation)
**Blocked by:** Nothing
**Related issues:** #199 (Design Token System), #205 (Typography)

### Problem
The DesignToken plan (#199) defines 6 color values. That's a shallow module — the interface is nearly as complex as the implementation. A deep token module absorbs shadows, radii, spacing scales, opacity levels, and font stacks behind the same 6-token interface.

### Solution
Expand `tailwind-config.js` to include:

**Color families (10 shades per token):**
```js
brand: { 50: '#eef2ff', 100: '#e0e7ff', …, 900: '#312e81' },
success: { 50: '#ecfdf5', …, 900: '#064e3b' },
warning: { 50: '#fffbeb', …, 900: '#78350f' },
danger: { 50: '#fef2f2', …, 900: '#7f1d1d' },
muted: { 50: '#f8fafc', …, 900: '#0f172a' },
surface: { 50: '#f8fafc', …, 900: '#020617' }
```

**Shadow tokens:**
- `shadow-brand-sm`: brand-colored subtle shadow for active elements
- `shadow-card-md`: neutral card elevation
- `shadow-panel-lg`: panel/modal depth

**Radius tokens:**
- `rounded-card` → `0.75rem` (consistent across all cards)
- `radius-pill` → `9999px` (filter pills, badges)
- `radius-input` → `0.5rem` (form fields)

**Opacity utilities per token:**
- `brand/10`, `brand/20`, `brand/30`, `brand/40`, `brand/50` for backgrounds, overlays

**Animation tokens:**
- `transition-instant`: 150ms ease-out (micro-interactions)
- `transition-fast`: 200ms spring (layout shifts, panel opens)
- `transition-normal`: 300ms ease-out (default)
- `transition-slow`: 500ms ease-in-out (page-level transitions)

**System font stack:**
```js
fontFamily: {
  sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif']
}
```

### Files affected
- `views/scripts/tailwind-config.js` — expanded config (50+ values)
- All view files — inherit richer vocabulary automatically

### Wins
- **Depth:** Interface is 6 names, implementation is 50+ computed values
- **Leverage:** One config change ripples through every view file
- **Locality:** All design decisions in one module, not scattered across EJS templates

---

## C1: Dark Mode (Strong)

**Blocks:** Nothing
**Blocked by:** #199 (Design Token System) — needs token infrastructure
**Related issues:** #199, #200 (Sidebar), all UI issues

### Problem
The 7-candidate plan builds an exclusively light UI. DesignToken defines surface as `slate-5` with no dark equivalent. Every token needs a dark-mode variant. Adding dark mode retroactively after all 7 candidates requires touching every view file twice.

### Solution
Extend the DesignToken module with `dark:*` color mappings in tailwind-config.js. Add `class="dark"` strategy on `<html>` driven by `prefers-color-scheme`. One toggle module, all views inherit.

**Dark mode token mapping:**
| Token | Light | Dark |
|-------|-------|------|
| surface | `#f8fafc` (slate-50) | `#1e293b` (slate-800) |
| brand | `#6366f1` | `#818cf8` (indigo-400) — lighter for contrast on dark |
| muted | `#64748b` | `#94a3b8` (slate-400) |
| text-primary | `#1e293b` | `#f1f5f9` (slate-100) |

**Implementation approach:**
1. Tailwind config enables `darkMode: 'class'`
2. Small JS module (`views/scripts/dark-mode.js`) reads `prefers-color-scheme` and toggles `<html class="dark">`
3. All view files use `dark:bg-surface-800`, `dark:text-muted-400`, etc. — no inline dark logic

**Toggle UI:** Sidebar gets a light/dark toggle button (sun/moon icon). Preference stored in `localStorage`.

### Files affected
- `views/scripts/tailwind-config.js` — `darkMode: 'class'` + dark color values
- `views/scripts/dark-mode.js` — NEW, system preference detection + toggle
- `views/layout.ejs` — dark mode script load + sidebar toggle button
- All view files — `dark:` variants on background/text classes

### Wins
- **Locality:** Dark mode logic in one token module + one detection script
- **Leverage:** Every view file benefits from the token seam automatically
- **Interface shrinks:** `dark:brand-500` works via Tailwind's dark variant — no conditional JS per element

### Grill questions
- Is this internal tool used in dark environments? If not, is dark mode worth the upfront cost?
- Should dark mode be a manual toggle only (no auto-detect) to keep it simple?
- Do we need dark mode for the admin panel too, or just the signal views?

---

## C2: Motion Design System (Strong)

**Blocks:** Nothing
**Blocked by:** #199 (Design Token System) — needs tailwind-config.js infrastructure
**Related issues:** #203 (Signal Detail tabs), #204 (Chat Panel)

### Problem
Current transitions are ad-hoc: Signal Detail uses `duration-1000` (1 second, sluggish), Chat panel uses `duration-300`, Phase text has inline CSS at `0.15s`. No shared motion vocabulary exists across 4 different durations and easing curves.

### Solution
Define 4 animation tokens in tailwind-config.js extending the Tailwind theme:

```js
theme: {
  transitionDuration: {
    instant: '150ms',   // Micro-interactions (hover, focus rings)
    fast: '200ms',      // Layout shifts, panel opens/closes
    normal: '300ms',    // Default transitions
    slow: '500ms'       // Page-level transitions (rare)
  },
  transitionTimingFunction: {
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',  // Bouncy, energetic
    smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',       // Material-style ease-out
  }
}
```

**Migration map:**
| Current | New | Usage |
|---------|-----|-------|
| `duration-1000` | `duration-fast` | Signal Detail layout shifts (3→1 state) |
| `duration-300` | `duration-normal` | Chat panel slide-in/out |
| `opacity 0.15s ease` | `duration-instant` | Phase text fade |
| `x-transition.opacity.duration.300ms` | `duration-normal` | Toast appear/disappear |

### Files affected
- `views/scripts/tailwind-config.js` — animation token definitions
- `views/layout.ejs` — remove inline CSS for phase transitions, use token classes
- `views/signal-detail.ejs` — `duration-1000` → `duration-fast`
- `views/_chatPanel.ejs` — `duration-300` → `duration-normal`

### Wins
- **Locality:** Motion decisions in one config module
- **Leverage:** Every transition across all views uses the same curves
- **Depth:** Token interface is 4 values, implementation absorbs per-view tuning

### Grill questions
- Should layout transitions (summary↔transcript) be faster than 200ms? Current 1000ms feels like a bug.
- Do we want spring physics for the chat panel slide-in, or keep it linear ease-out?
- Should motion respect `prefers-reduced-motion`? (Accessibility implication.)

---

## C3: Accessibility — Keyboard Navigation & ARIA (Strong)

**Blocks:** Nothing
**Blocked by:** #201 (Card List), #202 (Filter Bar), #203 (Detail Tabs) — needs the new UI elements first
**Related issues:** All UI issues

### Problem
The entire UI is mouse-only. Filter pills have no `tabindex`, no `role=group`. Signal Detail tabs lack `role=tablist`. Chat panel has no focus trap and no Escape-to-close. A state-of-the-art UI is keyboard-accessible by default.

### Solution
Add keyboard patterns behind the UiStateModule seam:

**Filter pills (roving tabindex):**
```js
// In filterBar() — ui-state.js
keydown(e) {
  const pills = this.$el.querySelectorAll('button');
  const current = Array.from(pills).indexOf(this.$refs.focusedPill || document.activeElement);
  if (e.key === 'ArrowRight') pills[(current + 1) % pills.length].focus();
  if (e.key === 'ArrowLeft') pills[(current - 1 + pills.length) % pills.length].focus();
  if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); // Button handles click
}
```

**Signal Detail tabs (`role=tablist`):**
- Container: `role="tablist"`
- Each tab: `role="tab"`, `aria-selected="{viewState === 'summary'}"`, `aria-controls="summary-pane"`
- Arrow key navigation between Summary / Transcript / Split

**Chat panel (focus trap + Escape):**
```js
// In chatPanel() — ui-state.js
init() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && this.chatOpen) this.toggleChat();
  });
}
```

**Focus management:**
- On filter change → focus stays on filter bar (no page jump)
- On chat open → focus moves to input field
- On chat close → focus returns to toggle button

### Files affected
- `views/scripts/ui-state.js` — NEW, keyboard handlers in `filterBar()`, `detailTabs()`, `chatPanel()`
- `views/signals.ejs` — ARIA attributes on filter pills
- `views/signal-detail.ejs` — `role=tablist` on toggle bar
- `views/_chatPanel.ejs` — Escape handler, focus management

### Wins
- **Locality:** Keyboard patterns in UiStateModule, not scattered inline
- **Leverage:** One focus-trap implementation serves both single-signal and multi-signal chat panels
- **Interface:** ARIA attributes are the test surface — verify with automated a11y tools

### Grill questions
- Is keyboard navigation a hard requirement for this internal tool?
- Should we add screen reader support (aria-live regions) or just keyboard nav?
- Do filter pills need roving tabindex, or is standard tab order sufficient?

---

## C9: Inline Style Extraction — Eliminate style= Attributes (Strong)

**Blocks:** Nothing
**Blocked by:** #199 (Design Token System) — needs token classes to replace inline values
**Related issues:** #199, #201 (Card List), #203 (Detail Tabs)

### Problem
Inline `style=` attributes bypass the token system entirely. `_signalsTable.ejs` line 36 uses `color: #eab308` (raw amber hex). `signal-detail.ejs` line 247 hardcodes `height: calc(100vh - 160px)`. These won't update when tokens change and leak color decisions into templates.

### Current inline styles found:
| File | Line | Inline style | Token replacement |
|------|------|-------------|-------------------|
| `_signalsTable.ejs` | 36 | `style="color: #eab308"` (NEW indicator) | `text-warning-500` |
| `_signalsTable.ejs` | 37 | `style="color: #a855f7; font-weight: 600"` (REVIEWED) | `text-brand-600 font-semibold` |
| `signal-detail.ejs` | 247 | `style="height: calc(100vh - 160px)"` | CSS custom property from token module |
| `layout.ejs` | 9-15 | Inline `<style>` block for chat table + phase transitions | Token-based classes |

### Solution
Replace all inline styles with token-based Tailwind classes. Container height → CSS custom property defined in tailwind-config.js:
```css
/* In layout.ejs <style> block */
:root { --main-content-height: calc(100vh - 160px); }
```
Then use `style="height: var(--main-content-height)"` or a Tailwind arbitrary value.

### Files affected
- `views/_signalsTable.ejs` — NEW/REVIEWED indicators
- `views/signal-detail.ejs` — container height
- `views/layout.ejs` — inline style block → token classes where possible

### Wins
- **Locality:** Color decisions move from templates to the token module
- **Leverage:** One hex change in config updates all usages
- **Deletion test:** Deleting inline styles concentrates styling in one module

---

## C4: Skeleton Loading States (Worth exploring)

**Blocks:** Nothing
**Blocked by:** #201 (Card List) — skeletons match the card shape
**Related issues:** #201, #202 (Filter Bar)

### Problem
When filter pills trigger HTMX requests, the table area goes blank for 200-800ms. Users see nothing — no spinner, no skeleton. The card layout (#201) makes this worse because cards are visually heavier than table rows.

### Solution
Add HTMX indicator via `hx-indicator` targeting skeleton card templates. 3 placeholder cards with `animate-pulse` appear during swap. Pure CSS, zero JS.

**Skeleton card template (in `_signalsTable.ejs`):**
```html
<div hx-indicator="#skeleton-loader" id="signals-table">
  …existing table/cards…
</div>

<template id="skeleton-loader">
  <div class="space-y-3">
    <div class="bg-white rounded-xl border border-slate-200 p-3 animate-pulse">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-slate-200 rounded"></div>
        <div class="flex-1 space-y-2">
          <div class="bg-slate-200 h-4 rounded w-3/4"></div>
          <div class="bg-slate-200 h-3 rounded w-1/2"></div>
        </div>
        <div class="w-8 h-8 bg-slate-200 rounded-full"></div>
      </div>
    </div>
    <!-- × 3 cards -->
  </div>
</template>
```

### Files affected
- `views/_signalsTable.ejs` — skeleton template + `hx-indicator` attribute
- `views/signals.ejs` — HTMX ajax calls include indicator target

### Wins
- **Locality:** Skeleton template lives in _signalsTable.ejs
- **Leverage:** Same pattern works for admin tab fragments

---

## C5: Empty State Design (Worth exploring)

**Blocks:** Nothing
**Blocked by:** #201 (Card List) — empty states use card-style containers
**Related issues:** #201, #204 (Chat Panel)

### Problem
Empty states are raw text ("No signals found.") with no illustration, no contextual suggestion. When filters produce zero results, users don't know whether the system is broken or their filters are too narrow.

### Solution
Design 3 empty state variants as EJS partials:

**Variant 1 — No signals yet:**
```html
<div class="text-center py-12">
  <svg>…poll icon…</svg>
  <p class="font-semibold text-slate-700">No signals yet</p>
  <p class="text-sm text-slate-500 mt-1">Run your first poll to start discovering content</p>
  <a href="/admin" class="mt-4 inline-block bg-brand-500 text-white px-4 py-2 rounded-lg">Go to Admin</a>
</div>
```

**Variant 2 — No matching signals:**
```html
<div class="text-center py-12">
  <svg>…filter icon…</svg>
  <p class="font-semibold text-slate-700">No signals match your filters</p>
  <p class="text-sm text-slate-500 mt-1">Active: <%= activeFilterSummary %></p>
  <a href="/signals?topicKey=&channelId=" class="mt-2 text-brand-600 text-sm">Clear all filters</a>
</div>
```

**Variant 3 — No chat history:**
```html
<div class="text-center py-8">
  <p class="text-sm text-slate-500">No questions yet. Try asking about the signals above!</p>
  <div class="mt-2 flex gap-2 justify-center">
    <button class="text-xs bg-slate-100 px-3 py-1 rounded-full" onclick="…">What's the overall sentiment?</button>
    <button class="text-xs bg-slate-100 px-3 py-1 rounded-full" onclick="…">Summarize key topics</button>
  </div>
</div>
```

### Files affected
- `views/_signalsTable.ejs` — empty state rendering (replaces line 13)
- `views/_chatHistory.ejs` — no-chat-history state
- `src/routes/signals-router.ts` — pass `activeFilterSummary` for contextual messaging

---

## C7: Chat UX — Typing Indicator & Message States (Worth exploring)

**Blocks:** Nothing
**Blocked by:** #204 (Chat Bubbles) — typing indicator lives inside the bubble container
**Related issues:** #204, #203 (Detail Tabs)

### Problem
The chat panel shows raw "processing…" / "Reasoning…" text during LLM work. State-of-the-art chat uses animated typing indicators (bouncing dots) and streaming token display within message bubbles.

### Solution
Replace phase text with animated dot indicator in the AI bubble. Phase details shown as subtle micro-label below the dots.

**Typing indicator component:**
```html
<div class="flex justify-end">
  <div class="bg-brand-50 rounded-2xl rounded-br-sm p-3 max-w-[80%]">
    <div class="flex gap-1 items-center typing-dots">
      <span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce" style="animation-delay:0ms"></span>
      <span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce" style="animation-delay:150ms"></span>
      <span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce" style="animation-delay:300ms"></span>
    </div>
    <p class="text-[10px] text-muted-400 mt-1 phase-label">Reasoning…</p>
  </div>
</div>
```

**Message states:**
| State | Visual |
|-------|--------|
| Pending (no LLM response yet) | Bouncing dots + phase micro-label |
| Streaming (tokens arriving) | Growing bubble with tokens, no dots |
| Done | Final answer in brand bubble, timestamp below |
| Failed | Red outline bubble + "Failed to generate" text + retry button |

**Message timestamps:** Each completed message shows `12:34 PM` in caption style below the bubble.

### Files affected
- `views/_chatAnswerStatus.ejs` — typing indicator replacing phase text
- `views/_chatHistory.ejs` — message bubbles with timestamps
- `views/scripts/chat-panel.js` — streaming target creation for growing bubble

---

## C6: Responsive Design — Mobile Breakpoint Strategy (Speculative)

**Blocks:** Nothing
**Blocked by:** #200 (Sidebar), #201 (Card List), #202 (Filter Bar) — needs the new layout first
**Related issues:** All UI issues

### Problem
The layout assumes a desktop viewport. Fixed `w-64` sidebar, fixed `w-[760px]` chat panel, multi-row pill layouts that don't scroll horizontally. Tablet and phone views are broken.

### Solution
Add responsive breakpoints via Tailwind prefixes:

**Sidebar (`md:` breakpoint = 768px):**
| Viewport | Behavior |
|----------|---------|
| `< md` (mobile) | Hamburger menu → slide-out drawer |
| `≥ md` (tablet+) | Icon-only sidebar (`w-16`) with tooltips on hover |
| `≥ lg` (desktop) | Full sidebar (`w-64`) with labels |

**Chat panel:**
| Viewport | Behavior |
|----------|---------|
| `< md` | Full-width overlay (no fixed width) |
| `≥ md` | Current `w-[760px]` slide-in |

**Filter pills:**
- Always horizontally scrollable (`overflow-x-auto`) on mobile
- Wrap on desktop (current behavior)

### Files affected
- `views/layout.ejs` — responsive sidebar classes
- `views/_chatPanel.ejs` — `md:w-[760px] w-full`
- `views/signals.ejs` — scrollable pill containers

### Grill questions
- Is this internal tool accessed from tablets/phones? If not, defer.
- Should the mobile layout be a separate view or just responsive classes on existing elements?

---

## Summary Matrix

| Candidate | Strength | Phase | Blocks | Blocked by | Files touched |
|-----------|----------|-------|--------|------------|--------------|
| C8: Deepen Tokens | Strong | 0 | — | — | tailwind-config.js |
| C1: Dark Mode | Strong | 1 | — | #199 | All views + new script |
| C2: Motion Design | Strong | 1 | — | #199 | config + 4 view files |
| C9: Inline Extraction | Strong | 1 | — | #199 | 3 view files |
| C4: Skeleton Loading | Worth | 2 | — | #201 | _signalsTable.ejs |
| C5: Empty States | Worth | 2 | — | #201 | 2 partials + 1 route |
| C7: Typing Indicator | Worth | 3 | — | #204 | 2 partials + 1 script |
| C6: Responsive | Speculative | 3 | — | #200-#202 | 3 view files |
| C3: Accessibility | Strong | 3 | — | #201-#203 | ui-state.js + 3 views |