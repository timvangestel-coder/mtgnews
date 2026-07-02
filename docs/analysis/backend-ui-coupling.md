# Backend-UI Coupling Analysis

**Date**: 2026-06-30
**Purpose**: Map all places where the backend generates frontend UI format, preparing for a refactor to pure JSON API + client-side rendering.

---

## Architecture Overview

**Current Stack**: Express.js backend → EJS templates + HTMX partial swaps + Alpine.js reactivity
**Target Stack**: Express.js JSON API → Client-side framework (local model/VM) → Pure UI layer

The backend currently uses **4 distinct mechanisms** to produce HTML/UI output:

---

## 1. ChatResponseFormatter — Markdown→HTML Pipeline

**File**: `src/chat-response-formatter.ts`
**Class**: `ChatResponseFormatterImpl` (singleton export)

### What it does
- Transforms raw LLM text into HTML using `marked` library (GFM mode)
- Generates timestamp citation pills as `<a>` tags with **hardcoded Tailwind CSS classes**:
  ```
  'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors'
  ```
- Process flow: parse citations → replace with HTML pills → protect pills → escape HTML → render markdown → restore pills

### Coupling Points
| Location | Type of Coupling | Severity |
|----------|-----------------|----------|
| `PILL_CLASSES` constant | Hardcoded Tailwind CSS classes in backend | HIGH |
| `processText()` method | HTML escaping + Markdown→HTML conversion | HIGH |
| Citation pill `<a>` tags | Full HTML elements generated server-side | HIGH |

### Consumers
- `src/services/chat-manager.ts` — uses `ChatResponseFormatter.format()` to transform LLM output before streaming tokens via SSE
- `src/services/signal-query-service.ts` — uses it for `summaryHtml` in signal detail

### Where Formatting Happens vs Streaming
In chat router: formatting happens **before** tokens are streamed. The LLM produces raw markdown text → `ChatResponseFormatter.format()` converts to HTML → HTML tokens are streamed to the client via SSE. The client receives HTML, not markdown.

---

## 2. formatTranscriptionHtml() — Transcription HTML

**File**: `src/signal-detail.ts`

### What it does
- Generates `<p>` tags with timestamp anchors and `<a>` pills for transcription segments
- Uses same `PILL_CLASSES` constant as chat-response-formatter (shared UI vocabulary leaked into backend)
- `escapeHtml()` sanitizes text before embedding in HTML

### Coupling Points
| Location | Type of Coupling | Severity |
|----------|-----------------|----------|
| `<p>` tag generation | HTML structure in backend | HIGH |
| Timestamp anchor `<a>` tags | Full HTML elements | HIGH |
| Shared `PILL_CLASSES` | UI styling leaked into domain layer | HIGH |

### Consumer
- `src/services/signal-query-service.ts` → `getSignalDetail()` returns `transcriptionHtml`

---

## 3. Route Handlers — Inline HTML Strings

Backend route handlers contain inline HTML strings returned via `res.send()`:

### admin-polling-router.ts (`src/routes/admin-polling-router.ts`)
| Line | Endpoint | Inline HTML |
|------|----------|-------------|
| 23 | POST `/admin/poll/trigger` | `<p class="text-gray-500">No poll runs yet.</p>` |
| 64 | POST `/admin/poll/abort/:id` | `<p class="text-gray-500">No poll runs yet.</p>` |
| 73 | GET `/admin/poll/progress` | `<p class="text-gray-500">No poll runs yet.</p>` |

### signals-router.ts (`src/routes/signals-router.ts`)
- Inline HTML for HTMX button swap callbacks (reviewed/irrelevant toggle buttons)
- Button state changes return swapped HTML fragments, not data

### admin-channels-router.ts
- `res.send('channel_id required')` — plain text error

---

## 4. EJS Template Rendering via res.render()

**Configuration**: `src/server.ts`
```javascript
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../../views'));
expressLayouts(app, express); // layout extractScripts: true, extractStyles: true
```

### Full Page Renders
| Route | Template | Data Shape |
|-------|----------|-----------|
| GET `/signals` | `signals.ejs` | topics[], channels[], filters, signals[], pagination, channelsMap |
| GET `/signal/:id` | `signal-detail.ejs` | signal, summaryHtml, transcriptionHtml, chat panel data |
| GET `/polls` | `polls.ejs` | runs[] with RunState/PollRunStep UI enums |
| GET `/poll/:id` | `poll-detail.ejs` | run detail, phases |
| GET `/admin` | `admin.ejs` | full admin dashboard data |

### HTMX Partial Renders (Fragment Responses)
These endpoints return EJS partials for HTMX's `hx-swap="outerHTML"`:

| Route | Template | Purpose |
|-------|----------|---------|
| POST `/admin/channels/add` | `admin/_channelsTab` | Full channels table refresh |
| POST `/admin/channels/remove` | `admin/_channelsTab` | Same |
| POST `/admin/poll/trigger` | `admin/_pollProgress` | Progress widget |
| POST `/admin/poll/abort/:id` | `admin/_pollProgress` | Same |
| GET `/admin/poll/progress` | `admin/_pollProgress` | Polling progress |
| GET `/admin/data-fragment` | `admin/_dataTab` | Data stats tab |
| POST `/admin/undo-all` | `admin/_dataTab` | Same |
| POST `/admin/purge-all` | `admin/_dataTab` | Same |

### Chat Panel Partials
| Template | Renders | Data Expected |
|----------|---------|---------------|
| `_chatPanel.ejs` | Full chat panel with history + input | signal, questions[] |
| `_chatAnswerStatus.ejs` | Chat status (thinking, error, done) | status, message — uses `<%- %>` unescaped HTML output |
| `_chatHistory.ejs` | Question/answer history | questions[] — answers are pre-formatted HTML |

---

## 5. EJS Templates with Embedded JavaScript

### layout.ejs
- Inline `__topicSubmit` function for admin topic actions
- Alpine.js 3.14.8 loaded globally
- Conditional script injection based on `activePage`

### signals.ejs  
- Alpine.js filter state machine embedded in template
- Template-level reactivity for filters, pagination

### signal-detail.ejs
- Timestamp navigation JS embedded
- Chat panel integration embedded

---

## 6. Frontend JavaScript (views/scripts/)

Scripts mounted via `express.static('/scripts', 'views/scripts/')`:
- Chat panel client-side logic
- Admin tabs management
- Scope source handling
- Timestamp navigation

These scripts operate on DOM elements rendered by EJS, creating tight coupling between server-rendered HTML structure and client-side behavior.

---

## Summary: Coupling Matrix

| Layer | Mechanism | Files Affected | Refactor Effort |
|-------|-----------|----------------|-----------------|
| **Domain → UI** | `ChatResponseFormatter` generates HTML | chat-response-formatter.ts, signal-detail.ts | HIGH — core formatting logic |
| **Service → UI** | Services return `summaryHtml`, `transcriptionHtml` | signal-query-service.ts, chat-manager.ts | MEDIUM — change return types |
| **Route → UI** | Inline HTML strings in route handlers | admin-polling-router.ts, signals-router.ts | LOW — replace with JSON |
| **Route → UI** | EJS template rendering | All routers (10+ files) | HIGH — full SSR→SPA migration |
| **Template → JS** | Embedded Alpine.js + inline scripts | 6 EJS templates | MEDIUM — extract to components |

---

## Refactor Strategy: JSON-First Architecture

### Phase 1: Decouple ChatResponseFormatter
- Split into `ChatResponseTextProcessor` (backend: citation parsing, text normalization) 
- Move HTML rendering to frontend component
- Backend returns structured data: `{ citations: [{timestamp, label}], markdown: "..." }`

### Phase 2: Decouple Transcription Formatting
- Return raw transcription segments as JSON array
- Frontend renders timestamp pills and paragraph structure
- Remove `formatTranscriptionHtml()` from backend

### Phase 3: Replace Inline HTML in Routes
- Convert `res.send('<p>...</p>')` to `res.json({message: '...', empty: true})`
- Client handles empty state rendering

### Phase 4: EJS → JSON API Endpoints
- Each `res.render()` call becomes a parallel `res.json()` endpoint
- Current EJS templates document the expected data shapes → use as API contract spec
- Frontend framework consumes JSON endpoints and renders components

### Phase 5: Remove View Layer
- Drop `ejs`, `express-ejs-layouts`
- Drop `views/` directory
- Static assets move to proper `public/` directory
- Frontend framework takes over routing (client-side router)

---

## Key Insight: The Formatting Seam

The current seam between backend data and frontend presentation is **non-existent**. The backend performs the complete pipeline:

```
Raw DB rows → Domain objects → Formatted HTML → HTTP response
```

The target architecture requires inserting a JSON boundary:

```
Raw DB rows → Domain objects → JSON API ← HTTP ← Frontend VM ← UI Components
```

The `ChatResponseFormatter` class is the deepest coupling point — it lives in the core formatting layer but contains Tailwind CSS class names. This is the textbook definition of mixed concerns and should be the first thing extracted during refactoring.