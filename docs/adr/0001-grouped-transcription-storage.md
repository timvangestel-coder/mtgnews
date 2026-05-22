# Store grouped transcription instead of raw segments

Transcription data stored in the DB uses a grouped `[{time: number, text: string}]` shape instead of raw per-segment `[{text, start, end}]`. Grouping (merging overlapping segments + ~10-second windowing) happens at ingestion time; raw segments are discarded.

**Why:** The LLM receives the transcription for summarization and produces `[T:ss]` timestamp references in summaries. When raw per-second segments are sent to the LLM, it freely references any second, but the Signal Detail page renders transcription grouped into ~10-second windows with anchors only at group boundaries. This mismatch caused timestamp links (`#t-47000`) to have no matching anchors in the DOM, requiring a fragile closest-match fallback. By storing grouped data, the LLM sees the same timestamps the UI renders, so timestamp links are exact matches.

**Considered Options:**
- Keep raw segments in DB, group at render time (current approach) — causes LLM/UI timestamp mismatch
- Keep raw segments, send grouped data to LLM — duplicates grouping logic in two places
- Store grouped data (chosen) — single source of truth, LLM and UI consume the same data

**Consequences:**
- LLM prompts are significantly shorter (fewer segments = fewer tokens)
- Timestamp links become exact matches (no closest-match fallback needed)
- Existing Signals with raw segment data become stale until re-processed (accepted trade-off)
- The stored shape is simpler: one field per group instead of three