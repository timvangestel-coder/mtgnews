# ADR-0019: UI Modernization — Grilling Decisions

**Date:** 2026-07-06
**Status:** Accepted
**Context:** Grilling session through issues #199–#205 and extra candidates C1–C9 from `extrauirequirements.md`. Resolves open design questions before implementation.

---

## Decision 1: Full 7-Issue Pass Committed

**Option chosen:** Commit to all 7 candidates (#199–#205) in one engineering pass. After this grilling session, the `to-issues` skill will be used to review/split issue slicing.

**Rationale:** User confirmed full scope commitment. The complete modernization is preferred over a phased incremental approach.

---

## Decision 2: Dark Mode Baked In — Auto-Detect + Manual Override

**Option chosen:** Include dark mode support from the start, using `darkMode: 'class'` strategy with auto-detect via `prefers-color-scheme` and manual override via sidebar toggle button. Preference stored in `localStorage`.

**Rationale:** User confirmed "Bake it in — I want dark mode support" and chose "Auto-detect + manual override (most polished)." Adding dark mode retroactively would require touching every view file twice.

**Implementation:**
- `darkMode: 'class'` in `tailwind-config.js`
- New `views/scripts/dark-mode.js` module: reads `prefers-color-scheme`, toggles `<html class="dark">`, persists to `localStorage`
- Sidebar gets sun/moon toggle icon
- All new view elements get `dark:` variants on background/text classes

**Dark mode token mapping:**
| Token | Light | Dark |
|-------|-------|------|
| surface | `#f8fafc` (slate-50) | `#1e293b` (slate-800) |
| brand | `#6366f1` | `#818cf8` (indigo-400) — lighter for contrast on dark |
| muted | `#64748b` | `#94a3b8` (slate-400) |

---

## Decision 3: Motion Design — 200ms Everywhere

**Option chosen:** Single unified duration of **200ms** for all transitions. Replaces the current ad-hoc durations (`duration-1000`, `duration-300`, inline `0.15s`).

**Rationale:** User wants fast but noticeable transitions. 200ms is the sweet spot between snappy and visible. Eliminates the need for a multi-level duration token system — one value, zero ambiguity.

**Implementation:**
- `transitionDuration: { default: '200ms' }` in tailwind-config.js
- All view transitions use `duration-default` (200ms)
- Spring easing (`cubic-bezier(0.34, 1.56, 0.64, 1)`) for layout shifts

---

## Decision 4: Full Accessibility — ARIA + Keyboard Navigation

**Option chosen:** Full keyboard support with proper ARIA attributes throughout.

**Rationale:** User chose "Full — proper ARIA + keyboard nav throughout."

**Patterns:**
- **Filter pills:** Roving tabindex (ArrowLeft/Right between pills)
- **Detail tabs:** `role="tablist"` with arrow key navigation, `aria-selected`, `aria-controls`
- **Chat panel:** Escape-to-close, focus trap when open, focus moves to input on open, focus returns to toggle button on close
- **All interactive elements:** Proper `tabindex`, `role`, `aria-*` attributes

---

## Decision 5: Deep Token Module — 10 Shades + Shadows + Radii

**Option chosen:** Expanded token module with 10 shades per token (50–900), shadow tokens, and radius tokens.

**Rationale:** Required for dark mode variants (need shade levels), hover states, subtle backgrounds, focus rings. User chose "Yes — deep token module."

**Scope (~60+ values in one config):**
- 6 color families × 10 shades = 60 color values
- Shadow tokens: `shadow-card-md`, `shadow-panel-lg`
- Radius tokens: `rounded-card` (0.75rem), `radius-pill` (9999px), `radius-input` (0.5rem)

---

## Decision 6: Responsive Design — Included Now

**Option chosen:** Add responsive breakpoints as part of this pass, not deferred.

**Rationale:** User confirmed "Yes — I use it on mobile/tablet, add responsive now."

**Strategy:**
- **Sidebar:** `< md` → hamburger menu + slide-out drawer; `≥ lg` → full sidebar (`w-64`)
- **Chat panel:** `< md` → full-width overlay; `≥ md` → current `w-[760px]` slide-in
- **Filter pills:** Always horizontally scrollable on mobile, wrap on desktop

---

## Decision 7: Chat — Keep Async Polling, Polish Visuals Only

**Option chosen:** NO real-time SSE streaming. Keep the existing async polling model (`_startStatusPolling`) and focus purely on visual polish (message bubbles, typing indicator with bouncing dots, gradient header).

**Rationale:** User chose "Keep async polling — just polish the visuals." Avoids backend changes to `llm.ts` streaming adapter for chat endpoints. The visual improvement (bubbles, typing dots) delivers the UX benefit without the SSE complexity.

**Implementation:**
- Message bubbles: User messages left-aligned (grey avatar + white bubble), AI messages right-aligned (brand avatar + light brand bubble)
- Typing indicator: Bouncing dots animation replacing raw "processing..." text
- Phase details shown as subtle micro-label below dots
- NO HTMX streaming, NO SSE targets

---

## Decision 8: Hard Rule — Zero Inline Styles

**Option chosen:** All styling goes through token-based Tailwind classes or CSS custom properties defined in the config module. No `style=` attributes in EJS templates.

**Rationale:** User chose "Hard rule — zero inline styles, everything via tokens." Ensures all design decisions flow through the token module.

**Migration map:**
| Current | Replacement |
|---------|-------------|
| `style="color: #eab308"` (NEW) | `text-warning-500` |
| `style="color: #a855f7; font-weight: 600"` (REVIEWED) | `text-brand-600 font-semibold` |
| `style="height: calc(100vh - 160px)"` | CSS custom property `--main-content-height` in `<style>` block |
| Inline phase transition CSS | Token-based classes + config-defined timing |

---

## Revised Rollout Sequence

1. **Foundation:** Deep token system (#199 expanded) + Dark Mode (C1) + Typography (#205) → `tailwind-config.js`, `dark-mode.js`
2. **Structure:** Sidebar (#200, responsive) + Card List (#201) + Filter Bar (#202, responsive)
3. **Polish:** Signal Detail tabs (#203) + Chat Panel visuals (#204, no streaming)
4. **Accessibility:** Keyboard nav + ARIA (C3) applied across all components
5. **Inline Extraction:** C9 cleanup pass — eliminate remaining `style=` attributes

## Files Affected (Updated)

| File | Changes |
|------|---------|
| `views/scripts/tailwind-config.js` | **NEW** — Deep tokens (60+ values), dark mode config, motion tokens, font stack |
| `views/scripts/dark-mode.js` | **NEW** — Auto-detect + manual toggle |
| `views/scripts/ui-state.js` | **NEW** — Alpine.js data functions with keyboard handlers |
| `views/layout.ejs` | Token config load, dark mode script, sidebar redesign (responsive), typography |
| `views/signals.ejs` | Filter command bar with segmented controls (responsive scroll) |
| `views/_signalsTable.ejs` | Table → card list layout, zero inline styles |
| `views/signal-detail.ejs` | Underline tabs, card container, ARIA tablist, CSS variable for height |
| `views/_chatPanel.ejs` | Message bubbles, gradient header, scope badge, responsive width |
| `views/_chatHistory.ejs` | Bubble rendering, typing indicator |
| `views/_chatAnswerStatus.ejs` | Bouncing dots replacing phase text |

## Cancelled / Deferred

- **C4: Skeleton Loading** — Deferred. Can be added after main pass if filter round-trips feel slow.
- **C5: Empty States** — Deferred. Nice-to-have polish.
- **C7: Typing Indicator** — Included in Decision 7 (bouncing dots as part of chat visual polish).