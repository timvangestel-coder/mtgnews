# Read-Out-Loud: Implementation Plan

## Design Decisions (from grilling session)

| Decision | Choice |
|---|---|
| TTS engine | **gspeak** (TypeScript gTTS rewrite, v0.0.4) — free, no API key, zero deprecated deps |
| Language | TypeScript — in-process `gspeak` async call, no child_process |
| Audio module | `src/services/speech-service.ts` — owns DB query + cache + gspeak call |
| Timestamp stripping | `src/strip-timestamps.ts` — pure function module, testable in isolation |
| Error handling | `asyncHandler` wrapper — `Promise.resolve(fn).catch(next)`, Express 5–ready |
| Storage | `data/mp3/{video_id}.mp3` on disk, served via `res.sendFile()` |
| Cache strategy | Check disk first → if exists, serve → if not, call gspeak, write buffer to disk, serve |
| Backend API | `GET /signals/:id/audio` — returns MP3 via `res.sendFile()`, cache-or-generate internally |
| Express static | **None** — only the route can serve audio (no bypass for missing summaries) |
| Button location | Right-aligned on the "Key Takeaways" heading row |
| Frontend module | `views/scripts/speaker-button.js` — dedicated Alpine.js module, not inline x-data, not UiState |
| Source text | Raw `signals.summary` column (not rendered HTML) |
| Playback UX | Click → spinner → auto-play; click again to stop; hidden `<audio>` element |

---

## Vertical Slices

### Slice 1: Backend — SpeechService + gspeak + audio endpoint

**Files to create/modify:**

1. **`src/strip-timestamps.ts`** (new)
   - Pure function: `stripTimestamps(text: string): string`
   - Regex remove `[T:\d+]`, `[MM:SS]`, `<<...>>` patterns
   - Unit-testable in isolation (no I/O, no DB)

2. **`src/services/speech-service.ts`** (new)
   - Import `gspeak` — `import { gspeak } from 'gspeak'`
   - Constructor receives `db: Database.Database`
   - Single public method: `async generate(videoId: string): Promise<{ stream: ReadStream, path: string } | null>`
   - Internal pipeline:
     1. Query `signals.summary` from DB by `video_id`
     2. If null → return null (caller sends 404)
     3. Call `stripTimestamps(clean_text)` to remove timestamp markers
     4. Ensure `data/mp3/` dir exists
     5. If `data/mp3/{video_id}.mp3` exists → return cached file path
     6. Else → `const buffer = await gspeak(text, { lang: 'en' })` → `fs.writeFileSync(path, buffer)` → return path
   - On error: clean up partial file, throw (caller handles 500)

3. **`src/routes/signals-router.ts`** (modify)
   - Add `asyncHandler` wrapper (shared helper or inline)
   - Add import: `SpeechService`
   - Add `GET /signals/:id/audio` handler:
     ```typescript
     router.get('/signals/:id/audio', asyncHandler(async (req, res) => {
       const result = await speechService.generate(req.params.id);
       if (!result) return res.status(404).send('No summary available');
       res.type('audio/mpeg').sendFile(result.path);
     }));
     ```
   - SpeechService instance passed via constructor or server.ts wiring

4. **`src/server.ts`** (modify)
   - Instantiate `SpeechService` with `useDb`
   - Pass to `createSignalsRouter(signalService, speechService)` — second param

**Test plan:**
- Unit test `stripTimestamps()`: `stripTimestamps("Hello [T:45] world")` → `"Hello  world"`
- Unit test `SpeechService.generate()`: mock `gspeak`, verify buffer written to disk, verify null returned for missing summary
- HTTP test: `curl http://localhost:3001/signals/{id}/audio` returns `audio/mpeg`
- Cache test: second call returns instantly (file exists)
- Missing summary: returns 404

---

### Slice 2: Frontend — Speaker button + audio playback on Signal Detail page

**Files to create/modify:**

1. **`views/scripts/speaker-button.js`** (new)
   - Exports `window.SpeakerButton = (videoId) => ({ ... })` — Alpine data object
   - State: `audioState` (`'idle'` | `'loading'` | `'playing'`), `audioEl` (Audio object)
   - `click()` handler: if playing → pause + reset; if idle/loading → create `new Audio('/signals/{video_id}/audio')`, listen for `canplaythrough` → auto-play, `ended` → reset to idle, `error` → reset to idle
   - Visual states returned as computed CSS classes: idle = muted icon, loading = pulsing brand color, playing = stop square in brand color
   - Hidden `<audio>` managed via JS `Audio()` constructor (no DOM element)

2. **`views/signal-detail.ejs`** (modify)
   - Add `<script src="/scripts/speaker-button.js"></script>` before `</head>` or in scripts block
   - Change the "Key Takeaways" `<h3>` to a flex row `<div>` with:
     - `<h3>Key Takeaways</h3>` on the left
     - Speaker `<button>` on the right (only rendered when `signal.summary` exists)
   - Alpine: `x-data="SpeakerButton('<%= signal.video_id %>')"` on the container div

**Test plan:**
- Load signal detail page with summary → speaker icon is visible right of "Key Takeaways"
- Click speaker → icon turns to pulsing spinner (loading state)
- Audio starts playing → icon switches to stop square
- Click stop → audio stops, icon returns to idle speaker
- Audio ends naturally → icon returns to idle speaker
- Load signal without summary → no speaker button rendered
- Switch to transcript-only view → button hidden (pane collapsed)

---

## Order of Execution

1. Slice 1 (Backend) — must exist before Slice 2 can be tested
2. Slice 2 (Frontend) — depends on backend endpoint

## Open Questions (resolved during grilling)

None — all design decisions are settled above.
