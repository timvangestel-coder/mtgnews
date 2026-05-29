# 0005 — Module Architecture Refactor: Route Modules with Service Layer

**Date:** 2026-05-28  
**Status:** Accepted  
**Issue:** #66

## Problem

`server.ts` contained 401 lines with 20+ route handlers monolithically defined alongside app bootstrap. `server.test.ts` was 1580 lines re-implementing the entire Express app inline. This created context memory pressure for LLM-assisted development and impeded both human and AI understanding of the codebase.

## Decision

Refactor into a three-layer architecture: **Route Modules → Service Layer → Domain Functions**. Implemented via vertical slices (one domain area at a time).

### Architecture

```
server.ts (~90 lines)
  ├── app.use(signalsRouter)          → SignalQueryService    → querySignals(), analyzeSignal()
  ├── app.use(pollsRouter)            → PollQueryService      → queryPollRuns(), getPollRunById()
  ├── app.use(adminChannelsRouter)    → ChannelManager        → addChannel(), removeChannel(), ...
  ├── app.use(adminTopicsRouter)      → TopicManager          → createTopic(), deleteTopic(), ...
  ├── app.use(adminPollingRouter)     → PollTriggerService    → enqueueRun(), abortRun()
  └── app.use(adminRouter)            → (composes all three managers/services for GET /admin)
```

### Layer Details

**Route Modules:** Express Router factories (`createSignalsRouter(service)`) that mount HTTP handlers for one domain area. Thin: parse params → call service → render template or redirect. Mounted via `app.use()` in server bootstrap.

**Service Layer:** Domain-specific orchestration modules (e.g., `SignalQueryService`, `ChannelManager`) that wrap DB access and coordinate multi-function operations. Services are the primary unit of testing — unit tests target services directly with in-memory SQLite, while route modules get lightweight HTTP smoke tests via supertest.

**Domain Functions:** Pure business logic (e.g., `querySignals()`, `analyzeSignal()`) unchanged from current state. Continue accepting explicit DB instances.

### Cross-Cutting Extractions

- **HTTP Retry Module:** Generic `fetchWithRetry(url, options, retryConfig)` extracted from `llm.ts`. Handles timeout, abort signal merging, transient error detection, exponential backoff. Consumer-agnostic (LLM client is current adapter).
- **Transcription Merge Module:** Pure-function module (`transcription-merge.ts`) with `mergeOverlappingSegments()` and `groupSegments()`. No I/O, no format detection — purely algorithmic.

### Test Strategy

Hybrid approach: service-level unit tests (primary) + HTTP smoke tests per route module (secondary). Shared test fixture provides in-memory DB + Express app creation.

### Implementation Order

Vertical slices by domain area (not horizontal layers):
1. Signals slice (router → SignalQueryService → tests)
2. Admin channels slice (router → ChannelManager → tests)
3. Admin topics slice (router → TopicManager → tests)
4. Admin polling slice (router → PollTrigger → tests)
5. Cross-cutting extractions (`fetchWithRetry`, `transcription-merge`)

Each slice is independently mergeable and verifiable. Target: no file exceeds 200 lines.

### Naming Convention

Two suffix conventions by responsibility: `-Service` for read-only query services (`SignalQueryService`, `PollQueryService`), `-Manager` for write/CRUD managers (`ChannelManager`, `TopicManager`). This distinction makes it clear at a glance whether a module reads data or modifies it.

## Consequences

- **Positive:** Clear seams between routing and domain logic. Parallel test execution via isolated in-memory DBs per file. Each route module is independently navigable by LLM context windows. Service layer enables focused unit testing without HTTP overhead.
- **Negative:** Adds indirection layer (router → service → domain function). More files to navigate initially (~10 new modules). Migration requires careful coordination to avoid breaking intermediate states — hence vertical slice approach.
- **Reversibility:** Structurally reversible but costly. Each vertical slice is independently revertable, reducing rollback scope if needed.

## Alternatives Considered

1. **Direct DB passing (no service layer)** — Router factories pass `db` directly to domain functions. Simpler but no real abstraction boundary; tests still need full HTTP stack. Rejected: wanted a testable seam between routes and domain logic.
2. **Horizontal refactoring** — Extract cross-cutting concerns first (retry, merge), then split routes. Rejected: each step alone doesn't reach 200-line target; higher risk of broken intermediate states.
3. **Generic service suffix** — All services named `*Service`. Rejected: "Service" is overloaded terminology; domain-specific names are more precise and align with existing glossary standards.