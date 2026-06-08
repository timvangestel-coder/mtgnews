# Async Job Pattern for SignalChat

SignalChat switched from synchronous SSE streaming to an async job pattern matching Poll Runs. Questions are submitted via POST (INSERT with `answer=NULL`, immediate return), then processed in the background via a global ConcurrencyPool shared with Poll analysis. Answers are persisted via UPDATE on success; failures leave `answer=NULL`. The UI uses HTMX polling (`hx-trigger="every 2s"`) instead of SSE streaming.

This decision was driven by three factors: (1) concurrent chat requests had no concurrency control, causing LM Studio overload and lost answers; (2) the synchronous model made it impossible to track pending questions for an X/Y ratio in the Signal List; (3) browser disconnect during streaming would lose the answer entirely. The async pattern reuses the existing Poll Run infrastructure (ConcurrencyPool, HTMX polling) rather than introducing a new streaming queue mechanism.

## Considered Options
- **Synchronous SSE with queue** — keep streaming but add a queue layer. Rejected: still loses data on disconnect, doesn't enable pending state naturally.
- **Two-phase with SSE reconnect** — more complex; would require server-side stream buffering and client reconnection logic. Deferred until needed.

## Consequences
- Chat no longer provides real-time token streaming to the browser.
- The `signal_chat.answer` column is now nullable, requiring a schema migration.
- Poll and Chat share LLM concurrency slots — chat may be delayed during active Poll runs.