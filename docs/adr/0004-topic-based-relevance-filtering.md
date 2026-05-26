# 0004 — Replace Per-Channel Filter Criteria with Topic-Based Filtering

**Date:** 2026-05-26  
**Status:** Accepted  
**Supersedes:** 0003-use-llm-for-content-relevance-filtering.md (partially — relevance mechanism stays; criteria source changes)

## Problem
ADR 0003 introduced free-text `filter_criteria` per channel. This worked for single-domain (MTG-only) use but created friction when expanding to multiple content domains (AI, sports, etc.): each admin had to manually write and maintain filter text per channel instead of reusing a shared topic definition. No way to group channels by domain or filter signals by domain on the Signal Viewer.

## Decision
Replace per-channel `filter_criteria` with a dedicated **Topic** entity. Topics are managed independently from Channels. Each Channel belongs to exactly one Topic (1:N). The Topic's `filter_text` replaces the channel's `filter_criteria` as the source of relevance criteria in the LLM prompt.

### Topic Model
Three fields:
| Field | Type | Example | Purpose |
|---|---|---|---|
| `key` | TEXT UNIQUE | `mtg`, `ai` | Machine-readable slug, primary identifier |
| `short_name` | TEXT | `MTG`, `AI` | UI display label |
| `filter_text` | TEXT NOT NULL | `"Content must be primarily about..."` | Relevance criteria injected into LLM prompt |

### Schema Changes
- **New table:** `topics (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, short_name TEXT NOT NULL, filter_text TEXT NOT NULL)`
- **Channels table:** add `topic_id INTEGER REFERENCES topics(id)`, drop `filter_criteria TEXT`
- **No denormalization on entity_mentions** — topic membership derived via join chain: `entity_mentions → signals → channels → topics`

### LLM Prompt Change
- Resolve filter text via: `channels.topic_id → topics.filter_text`
- Generic analyst role: `"You are a content analyst"` (replaces hardcoded `"You are an MTG analyst"`)
- Domain scoping handled entirely through Topic's `filter_text` — no per-topic role prompts
- Entity types remain free-form (not constrained per-topic)

### Polling Impact
- Channels with `topic_id IS NULL` are **blocked from polling** (no filter text = no relevance check possible)
- Active channels query: `WHERE active = 1 AND topic_id IS NOT NULL`

### UI Changes
- **Admin Panel:** Tabbed layout — [Channels] [Topics] [Polling]
  - Channels tab: add channel form includes required topic dropdown; WatchList shows topic badge per channel + change-topic control
  - Topics tab: full CRUD (add/edit/delete); force-delete sets channel `topic_id` to NULL
- **Signal Viewer:** Hierarchical filter — Row 1 = Topic pills, Row 2 = Channel pills. Selecting a topic filters visible channels. Default state: no topic selected → show all signals and all channels.

### Migration Strategy
- No auto-migration of existing channels to a default topic
- After schema upgrade, existing channels will have `topic_id = NULL` until admin manually assigns
- Existing `filter_criteria` values lost on column drop — admin must recreate filter_text in Topics tab

## Consequences
- **Positive:** Single source of truth for domain filtering. Admin writes filter text once per topic, not once per channel. Enables topic-based signal browsing. Cleaner separation between "what we watch" (channels) and "what it's about" (topics).
- **Negative:** Loss of per-channel filter nuance (a channel covering a niche subtopic can't override the topic's broad filter). Force-delete creates orphaned channels temporarily blocked from polling. Migration requires manual admin action post-deploy.
- **Reversibility:** Schema change is destructive (`filter_criteria` column dropped). Reversal requires recreating `filter_criteria` on channels and restoring values from backups. Topic table can be dropped; channel-level filters would need to be re-added.

## Alternatives Considered
1. **Soft deprecate filter_criteria** — keep as optional per-channel override alongside topic default. Rejected: added prompt assembly complexity (merge/override logic) for marginal benefit. Per-channel nuance not needed at current scale.
2. **M:N Channel-Topic relationship** — allow channels to span multiple topics. Rejected: complicates polling (which topic's filter applies during LLM call?), signal filtering, and UI. Current use case is single-topic-per-channel.
3. **Auto-create default "mtg" topic on migration** — assign all existing channels automatically. Rejected: admin should explicitly confirm topic assignments rather than assume correctness. NULL-topic → blocked polling forces awareness.