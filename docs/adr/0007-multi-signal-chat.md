# Multi-Signal Chat with Polymorphic Scope Resolution

SignalChat extended to support list-scoped (multi-signal) questions on the Signal List page, alongside existing per-signal chat on Signal Detail. A single `signal_chat` table serves both scopes via polymorphic columns: per-signal rows have `signal_video_id` set; list-scoped rows have `signal_video_id=NULL` with filter criteria (`topic_key`, `channel_id`, `include_irrelevant`) identifying the signal set.

## Key Decisions

**Scope resolution:** `resolveScope(scope): ChatSignalContext[]` internal to ChatManager replaces direct SQL in chat methods. The polymorphic `ChatScope` object `{ videoId?, topicKey?, channelId?, includeIrrelevant? }` is persisted in each row so scope survives the async queue pipeline (enqueue → DB insert → process).

**History separation:** List and per-signal conversations are strictly separated. Each unique filter-composite `(topicKey, channelId, includeIrrelevant)` forms its own conversation — narrowing filters creates a new conversation rather than inheriting history from broader scopes.

**Citation format:** LLM instructed to use `<<videoId:T:ss>>` delimiters for signal citations in multi-signal answers. A dedicated `CitationFormatter` module transforms these into clickable pill links (`/signals/{videoId}#t-{ms}`) with signal title and timestamp. TimestampFormatter becomes an internal adapter of CitationFormatter.

**Prompt assembly:** New `assembleMultiSignalChat()` function produces XML `<signals><signal video_id="...">` blocks per signal, each containing transcription and summary. Prompt instructs LLM to cite sources using delimiter format. Unification of all three `assemble*` functions deferred — adding a fourth function is acceptable; refactoring 4→1 can happen later when pain justifies it.

**UI:** 760px slide-in panel on Signal List (vs. 380px on Signal Detail). Scope badge in header displays filter context and signal count. Filter changes trigger toast warning but preserve open chat state. Chat persists across pagination HTMX swaps; closes on full-page navigation to Signal Detail.

## Considered Options
- **Separate table for list chat** — rejected: duplicates schema, history logic, and queue handling for no real benefit over nullable columns.
- **SignalCollection entity** — rejected: introduces indirection (scope → collection → signals) where filter criteria on the row is sufficient.
- **Hierarchical history** — rejected: inheriting Q&A from broader scopes would pollute LLM context with out-of-scope conversations.

## Consequences
- `signal_chat` table gains 3 nullable columns; existing per-signal rows unaffected (filter columns remain NULL).
- ChatManager interface deepens: single `resolveScope()` serves both modes instead of scattered SQL queries.
- CitationFormatter replaces TimestampFormatter as the public transform seam for multi-signal answers.
- All filtered signals (no cap) included in prompt — may hit context window limits with large signal sets. Optimization deferred to future iteration.

**Issues:** #127–#132. https://github.com/timvangestel-coder/mtgnews/issues/127 through https://github.com/timvangestel-coder/mtgnews/issues/132