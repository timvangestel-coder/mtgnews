# ADR-0017: RSS Feed Fetcher Adapter with Retry, Backoff, and Status Awareness

**Date:** 2026-07-02
**Status:** Accepted
**Issue:** [#198](https://github.com/timvangestel-coder/mtgnews/issues/198)

## Problem

YouTube RSS feeds return HTTP 404 for most channels when the server IP is rate-limited/blocked. The current architecture has no defense:

- `fetchUrl()` performs raw `https.get` with no HTTP status check — 404 HTML resolves as "success"
- No retry on transient errors
- No backoff memory between poll runs
- Burst pattern: 9 channels fire back-to-back with zero delay
- Parse failures swallow the real cause (status code lost)

## Decision

Introduce a `RssFeedFetcher` deep module that replaces the raw `fetchUrl()` / `fetchRssSync()` functions in `rss-discovery.ts`. The module provides HTTP status awareness, typed errors, retry with backoff, and inter-request delay.

### Module Interface

```typescript
interface RssFetchResult {
  xml: string;
  status: number;
}

class RssFeedFetcher {
  async fetch(channelId: string): Promise<RssFetchResult>; // throws RssError
  private checkBackoff(channelId: string): boolean;
  private recordFailure(channelId: string, statusCode: number): void;
  private resetBackoff(channelId: string): void;
  private fetchWithStatus(url: string): Promise<{ status: number, body: string }>;
}

class RssError extends Error {
  static isRateLimited(e: unknown): boolean;    // 429
  static isBadChannel(e: unknown): boolean;      // 404 on never-successful channel
  static isTransient(e: unknown): boolean;       // 5xx, network, or 404 on established channel
  statusCode: number;
  channelId: string;
}
```

### Decision 1: Hybrid Backoff (Per-Channel + Global IP-Level)

**Rationale:** YouTube rate-limits at the IP level. If Channel A triggers a 429, Channels B-N will also fail because they share the same outgoing IP. Pure per-channel backoff would miss this correlation.

**Design:**
- Per-channel backoff for persistent channel-specific failures (e.g., private feeds returning 404)
- Global cooldown row triggered by any 429, blocking ALL channels until it expires
- The global row uses a synthetic key `'__global__'` in the same table

### Decision 2: Immediate Backoff Reset on First Success

**Rationale:** RSS feeds are either available or they're not — there's no "flaky recovery" pattern with YouTube. If the fetch succeeds, the IP is unblocked and the channel is healthy. Adding a consecutive-success counter adds columns and logic for a scenario that doesn't match the real failure mode.

**Design:** First successful `fetch()` clears all backoff state for that channel: `consecutive_failures = 0`, row deleted from `rss_backoff`.

### Decision 3: HTTP 404 — Hybrid Established vs New Channel

**Rationale:** YouTube abuses 404 as a rate-limiting mechanism (returning 404 instead of 429 when blocking RSS for an IP). A genuine 404 means the channel doesn't exist. Distinguishing between the two requires history: channels that have successfully returned RSS data in the past are real — a sudden 404 on them is a YouTube IP block.

**Design:**
- Track `ever_successful` boolean in backoff state
- **Established channel** (`ever_successful = true`) returns 404 → treat as transient: apply per-channel + global backoff
- **New channel** (`ever_successful = false`) returns 404 twice → hard failure: mark as bad channel, stop retrying, alert operator

### Decision 4: Inter-Request Delay — 1s Default with Env Var

**Rationale:** A 2s delay adds ~16 seconds per poll run for 9 channels, which is excessive. A 1s gap breaks up burst patterns without adding significant overhead (~8 seconds total). Power users can increase via `POLL_REQUEST_DELAY_MS` if aggressively rate-limited.

**Design:**
- Default: `POLL_REQUEST_DELAY_MS=1000` (read from env, fallback to 1000)
- Applied in the worker loop between channel iterations in `poll-run-manager.ts`
- Global backoff check runs before each fetch; if global cooldown is active, skip remaining channels for this run

### Backoff State Table

```sql
CREATE TABLE rss_backoff (
  channel_id         TEXT PRIMARY KEY,          -- '__global__' for IP-level cooldown
  backoff_until_ms   INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 1,
  last_status_code   INTEGER,
  ever_successful    INTEGER DEFAULT 0          -- distinguishes established vs new channels
);
```

Exponential growth: 30s → 1m → 2m → 5m cap. Reset on success (row deleted).

### Integration Points

**poll-run-manager.ts worker loop:**
```typescript
for (const channel of channels) {
  // Check global cooldown first
  if (fetcher.isGlobalCooldownActive()) {
    console.log(`Global RSS cooldown active, skipping remaining channels`);
    break;
  }

  // Check per-channel backoff
  if (fetcher.isInBackoff(channel.channel_id)) {
    upsertProgress(channel.channel_id, 'backoff', 0);
    continue;
  }

  // Inter-request delay
  if (channelIndex > 0) await delay(POLL_REQUEST_DELAY_MS);

  try {
    const result = await pollChannel(this.db, channel.channel_id, opts);
    fetcher.resetBackoff(channel.channel_id);  // success clears backoff
    // ... dispatch analysis tasks
  } catch (err) {
    if (RssError.isRateLimited(err)) {
      fetcher.recordFailure(channel.channel_id, err.statusCode);  // triggers global cooldown
    }
    upsertProgress(channel.channel_id, 'failed', 0);
  }
}
```

**rss-discovery.ts:**
```typescript
// Replace fetchRssSync with RssFeedFetcher.fetch(channelId)
try {
  const { xml } = await fetcher.fetch(id);
  const entries = parseRssFeed(xml);
} catch (err) {
  if (RssError.isBadChannel(err)) {
    // Hard failure — channel ID is invalid
    fetchErrors.push(id);
  }
  // Transient errors already recorded in backoff state by fetcher
}
```

### Implementation Order

1. **HTTP status awareness** (~10 lines) — Add statusCode check to `fetchUrl()`, reject non-2xx with typed error
2. **RssFeedFetcher adapter** (~80 lines) — Extract class wrapping status-aware fetch + retry, define RssError types
3. **Backoff state table + logic** (~60 lines) — Add `rss_backoff` table, check/record/reset methods, wire into worker skip logic
4. **Inter-request delay** (~5 lines) — One line in worker loop + env var

**Total estimated effort:** ~155 lines across 3 files + 1 DB table.

## Consequences

| Positive | Negative |
|---|---|
| Channels show "backoff" instead of "failed" when temporarily rate-limited | New table adds migration complexity |
| Global cooldown prevents cascading failures across all channels | Inter-request delay adds ~8s per poll run |
| Typed errors make root cause visible in logs | Hybrid 404 logic requires `ever_successful` tracking |
| Exponential backoff reduces wasted API calls | |

## Files Involved

- `src/rss-discovery.ts` — main changes (`fetchUrl` → `RssFeedFetcher`)
- `src/poll-run-manager.ts` — backoff check + inter-request delay in worker loop
- `src/db/init-db.ts` — `rss_backoff` table migration
- `src/utils/poll-run-view-model.ts` — new "backoff" progress state for UI