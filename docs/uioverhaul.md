# UI Overhaul — Design Modernization Candidates

> Generated: July 6, 2026
> Visual report: `%TEMP%/ui-modernization-review-20260706.html` (open with `start %TEMP%/ui-modernization-review-20260706.html`)
> Source skill: `improve-codebase-architecture`

## Current State Assessment

### Visual Identity
- No design system or token layer — colors chosen per-component with no shared vocabulary
- Inconsistent color palette: blue (active nav), green (date filter), orange (irrelevant toggle), purple (reviewed button), indigo (chat panel), gray-900 (sidebar)
- Dark sidebar (`bg-gray-900`) feels disconnected from the light content area
- No typography hierarchy beyond bold/regular weight

### Layout & Spacing
- Dense table layout in Signal Viewer with minimal breathing room between rows
- Filter pills crowd the top of Signal Viewer across two ungrouped rows
- No responsive breakpoints defined — fixed widths (e.g., chat panel at 760px)
- Chat panel uses `w-[760px] max-w-full` with no fluid sizing

### Interaction & Feedback
- No loading skeletons or transitions beyond basic opacity changes
- Status badges use raw color blocks (`bg-green-600`, `bg-orange-500`) with no icons
- "NEW" and "REVIEWED" indicators use inline `style="color: #eab308"` text labels instead of visual pill badges
- No empty-state illustrations or guidance when lists are empty

---

## Candidate 1: Design Token System (STRONG)

**Files:** `layout.ejs`, `signals.ejs`, `_signalsTable.ejs`, `signal-detail.ejs`, `admin.ejs`, `polls.ejs`

**Problem:** Six unrelated color families create visual noise. No semantic mapping between color and meaning. Each component invents its own colors.

**Solution:** Define a Tailwind theme extension with 6-8 semantic tokens plus a neutral scale. Replace all hardcoded Tailwind color classes with token references.

**Proposed tokens:**
| Token | Color | Usage |
|-------|-------|-------|
| `--color-brand` | `#6366f1` (indigo) | Primary actions, active states, links |
| `--color-success` | `#10b981` (emerald) | Positive sentiment, done status |
| `--color-warning` | `#f59e0b` (amber) | Forced runs, new signals, attention |
| `--color-danger` | `#ef4444` (red) | Failed runs, irrelevant marking |
| `--color-muted` | `#64748b` (slate) | Inactive pills, borders, secondary text |
| `--color-surface` | `#f8fafc` (slate-50) | Card backgrounds, panel surfaces |

**Implementation:** Add to Tailwind config in `layout.ejs`:
```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          brand: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
          success: { 50: '#ecfdf5', 100: '#d1fae5', 500: '#10b981', 600: '#059669', 700: '#047857' },
          warning: { 50: '#fffbeb', 100: '#fef3c7', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
          danger: { 50: '#fef2f2', 100: '#fee2e2', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c' },
        }
      }
    }
  }
</script>
```

**Wins:**
- Leverage: one config file, every component inherits
- Locality: all color decisions centralized in layout module
- Zero breaking changes — existing Tailwind classes still work as fallback

---

## Candidate 2: Sidebar Navigation Redesign (STRONG)

**Files:** `layout.ejs`

**Problem:** Dark sidebar (`bg-gray-900`) with no icons creates a heavy, disconnected feel. Active state uses saturated blue (`bg-blue-600`) that fights the content area visually. No app logo or visual identity mark.

**Solution:** Switch to a light sidebar with icon + label nav items. Use brand color for active states with subtle background tint instead of full saturation. Add an app logo mark.

**Before (current):**
```html
<aside class="sidebar w-64 bg-gray-900 text-white p-4">
  <h1 class="text-xl font-bold mb-6">MTG News</h1>
  <nav class="space-y-2">
    <a href="/signals" class="... bg-blue-600">Signals</a>
    <a href="/polls" class="... hover:bg-gray-700">Run History</a>
    <a href="/admin" class="... hover:bg-gray-700">Admin Panel</a>
  </nav>
</aside>
```

**After (proposed):**
- Background: `bg-white border-r border-slate-200`
- Logo: `<div class="w-8 h-8 rounded-lg bg-brand-500">M</div>` + "MTG News" label
- Nav items: SVG icon + text, `px-3 py-2 rounded-lg`, active state = `bg-brand-50 text-brand-700 font-medium`
- Inactive: `text-slate-600 hover:bg-slate-50`

**Wins:**
- Leverage: `layout.ejs` is the single interface for all pages
- Locality: nav styling concentrated in one module
- Visual continuity between sidebar and content area

---

## Candidate 3: Signal Card List Layout (STRONG)

**Files:** `_signalsTable.ejs`, `signals.ejs`

**Problem:** Dense `<table>` layout wastes horizontal space on separate date/time columns. Text badges ("NEW", "REVIEWED") use inline styles (`style="color: #eab308"`) and compete with signal titles for attention. Sentiment shown as raw number in colored pill.

**Solution:** Card-based list with rounded containers, channel avatar icons, sentiment as a circular badge, and structured metadata row. Replace inline-style text indicators with proper pill badges using the token system.

**Card structure (proposed):**
```
┌─────────────────────────────────────────────────────┐
│ [ICON]  Title                    [NEW]    (sentiment)│
│         Date · Channel · Q: 3/5                       │
└─────────────────────────────────────────────────────┘
```

- Container: `bg-white rounded-xl border border-slate-200 p-3 hover:shadow-md`
- Icon: `w-10 h-10 rounded-lg bg-brand-100` with topic-specific SVG icon
- Title: `text-sm font-medium text-slate-900 truncate`
- Metadata row: `text-xs text-slate-500` with `·` separators
- Sentiment: circular badge, `w-8 h-8 rounded-full`, color from token system
- NEW indicator: `px-1.5 py-0.5 rounded bg-warning-100 text-warning-700 text-[10px] font-semibold`
- REVIEWED indicator: `px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[10px] font-semibold`

**Wins:**
- Leverage: card pattern reuses across pages (polls, admin lists)
- Locality: signal row styling in one module (`_signalsTable.ejs`)
- Eliminates inline styles entirely

---

## Candidate 4: Filter Command Bar (WORTH EXPLORING)

**Files:** `signals.ejs`

**Problem:** Three color families (blue for topic, green for date, orange for toggle) create visual confusion. Pills scatter across two rows with no grouping. "Show Unreviewed" and "Show Irrelevant" toggles compete for space with Topic/Channel pills.

**Solution:** Grouped segmented controls inside a unified card container. Topic/Channel use one style group, Date uses another. Toggles collapse behind a filter icon button when not active.

**Layout (proposed):**
```
┌──────────────────────────────────────────────────────┐
│ [All Topics ● MTG ● AI] │ [All ● Week ● Month]      │
│ [All Channels ● MTG Bazaar ● White Box ...]  [⚙]    │
└──────────────────────────────────────────────────────┘
```

- Outer container: `bg-white rounded-xl border border-slate-200 p-3`
- Segmented groups: `flex bg-slate-100 rounded-lg p-0.5` (pill container)
- Active pill: `rounded-md bg-brand-500 text-white font-medium`
- Inactive pill: `text-slate-600 hover:bg-slate-200 rounded-md`
- Separator between groups: `h-5 w-px bg-slate-200`
- Filter icon button for toggles: shows only when a toggle is active

**Wins:**
- Leverage: segmented control pattern reusable on Admin tabs, poll filters
- Locality: filter UI in one visual module
- Reduces vertical space from 2 rows to a compact command bar

---

## Candidate 5: Signal Detail Polish (WORTH EXPLORING)

**Files:** `signal-detail.ejs`

**Problem:** Toggle bar with six buttons (Summary, Transcript, Split, Mark Irrelevant, Reviewed, Summarize) creates horizontal overflow on narrow screens. Bordered container (`border rounded`) feels boxy and dated. Action buttons compete visually with view-state toggles — all use the same `px-4 py-2 rounded` styling.

**Solution:** Underline-style tab navigation for Summary/Transcript/Split. Move action buttons to a kebab menu (three-dot icon) or subtle icon bar on the right. Use card containers with rounded corners and soft shadows instead of hard borders.

**Before (current):**
```html
<button>Summary</button> <button>Transcript</button> <button>Split</button>
<button>Mark as Irrelevant</button> <button>Reviewed ✓</button>
```

**After (proposed):**
```
┌──────────────────────────────────────────────────────┐
│ Title                              [Channel Badge]    │
│ ─────────────────────────────────────────────────────│
│ Summary  |  Transcript  |  Split              [...]  │
│ ─────────────────────────────────────────────────────│
│                                                      │
│  ┌─ Key Takeaways (card with rounded corners) ───┐   │
│  │ • Finding 1                                    │   │
│  │ • Finding 2                                    │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Tab bar: `border-b border-slate-200`, active tab = `text-brand-600 border-b-2 border-brand-500`
- Inactive tabs: `text-slate-500 hover:text-slate-700`
- Actions: kebab menu (`[...]`) with dropdown for "Mark Irrelevant", "Toggle Reviewed", "Summarize"
- Content container: `bg-white rounded-xl border border-slate-200 shadow-sm`

**Wins:**
- Locality: view-state UI in one visual module
- Leverage: tab pattern reuses on Admin panel tabs
- Eliminates horizontal button overflow

---

## Candidate 6: Chat Panel Polish (WORTH EXPLORING)

**Files:** `_chatPanel.ejs`, `_chatHistory.ejs`

**Problem:** Chat panel uses a bare left border (`border-l border-gray-200`) with no visual hierarchy. Q/A entries use `border-t` separators with `<strong>Q:</strong>` / `<strong>A:</strong>` labels — no message bubbles, making them hard to scan quickly. Floating toggle button is visually disconnected from the panel.

**Solution:** Message-bubble layout with user/AI avatars. Gradient header with scope badge. Rounded input bar with integrated send icon. Soft shadow on the panel for depth.

**Before (current):**
```html
<div class="border-t border-gray-200 pt-3">
  <div><strong>Q:</strong> What cards were mentioned?</div>
  <div><strong>A:</strong> LinoleaBlade, Smothering Tithe...</div>
</div>
```

**After (proposed):**
```
┌──────────────────────────────────────┐
│ AI Assistant          [3 signals]  ✕ │  ← gradient header
├──────────────────────────────────────┤
│                                      │
│  (Y) What cards were mentioned?      │  ← user bubble (left)
│                                      │
│       LinoleaBlade, Smothering... (AI)│  ← AI bubble (right)
│                                      │
├──────────────────────────────────────┤
│ [Ask about these signals...]    [➤]  │  ← rounded input bar
└──────────────────────────────────────┘
```

- Panel: `rounded-xl shadow-lg border border-slate-200` (replaces flat `border-l`)
- Header: `bg-gradient-to-r from-brand-500 to-purple-500`, white text, scope count badge
- User messages: left-aligned, `bg-white rounded-xl rounded-tl-none border border-slate-200`, avatar = gray circle with initial
- AI messages: right-aligned, `bg-brand-50 rounded-xl rounded-tr-none border border-brand-100`, avatar = brand-colored circle with chat icon
- Input bar: `bg-slate-100 rounded-xl px-4 py-2.5` + circular send button

**Wins:**
- Locality: chat visual module self-contained in `_chatPanel.ejs` / `_chatHistory.ejs`
- Leverage: bubble pattern is standard across modern Q&A UIs
- Dramatically improved scanability of conversation history

---

## Candidate 7: Typography & Spacing Scale (SPECULATIVE)

**Files:** `layout.ejs`, all view templates

**Problem:** No documented type scale. Font sizes chosen per-component (`text-2xl` for page titles, `text-lg` for sections, `text-sm` for cells, `text-xs` for badges) with no rhythm or tracking between levels. Line-height defaults to browser standard (1.5) everywhere — no distinction between body copy and dense metadata.

**Solution:** Define a 4-level type scale using system font stack. Add consistent spacing tokens for vertical rhythm.

**Proposed scale:**
| Level | Size | Weight | Tracking | Usage |
|-------|------|--------|----------|-------|
| Display | `text-2xl` (24px) | 700 | tight (-0.025em) | Page titles ("Signals", "Run History") |
| Heading | `text-lg` (18px) | 600 | tight (-0.0125em) | Section headers ("Key Takeaways") |
| Body | `text-base` (16px) | 400 | normal | Paragraph text, chat answers |
| Caption | `text-sm` (14px) / `text-xs` (12px) | 500 | wide (0.025em) | Metadata, badges, pills |

**Spacing tokens:** `space-2` (8px), `space-3` (12px), `space-4` (16px), `space-6` (24px) for consistent vertical gaps between sections.

**Implementation:** Add to Tailwind config:
```js
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'] },
      lineHeight: { 'body': '1.75', 'dense': '1.25' }
    }
  }
}
```

**Wins:**
- Leverage: type scale applies globally to all views
- Locality: typography decisions centralized in layout module
- Consistent reading experience across Signal Detail, Chat, and Admin pages

---

## Recommended Rollout Sequence

```
1. Design Token System (foundation)
   ├── 2. Sidebar Navigation (structure)
   ├── 3. Signal Card List (structure)
   │    └── 4. Filter Command Bar (structure)
   │         ├── 5. Signal Detail Polish (polish)
   │         └── 6. Chat Panel Polish (polish)
   └── 7. Typography Scale (polish, global)
```

**Phase 1 — Foundation (30 min):** Token system in `layout.ejs`. No visual changes visible yet, but establishes the vocabulary for all subsequent changes.

**Phase 2 — Structure (1-2 hours):** Sidebar + Signal Cards + Filter Bar. These three changes together transform the primary navigation and data display surfaces.

**Phase 3 — Polish (1 hour):** Signal Detail tabs, Chat Panel bubbles, Typography scale. Final visual refinements that make the UI feel complete.

---

## Grill-Ready Questions

Use these when running `grill-me` or `grilling` skill on this overhaul:

1. **Scope boundary:** Do we overhaul all four pages (Signals, Signal Detail, Run History, Admin) in one pass, or phase by page?
2. **Token ownership:** Should the Tailwind config live in `layout.ejs` (current pattern) or extract to a dedicated `tailwind.config.js` file?
3. **Card vs table tradeoff:** Cards improve visual design but lose column alignment for date/sentiment comparison. Is this acceptable for the Signal Viewer's primary use case (scanning titles)?
4. **Filter bar complexity:** The current two-row pill layout supports 6+ filter dimensions. Does collapsing toggles behind a filter icon add too many clicks?
5. **Chat panel width:** Current fixed `760px` vs fluid `w-[min(760px,80vw)]`. What's the right breakpoint for mobile?
6. **Icon library:** Inline SVGs (current pattern) vs an icon package (Lucide/Heroicons)? Added dependency vs consistency?
7. **Admin panel tabs:** Current rounded-pill tabs match Candidate 4's segmented control. Should Admin tabs adopt the same pattern as the Filter Command Bar?