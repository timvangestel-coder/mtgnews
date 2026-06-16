# ADR-0003: CompactTranscription for Multi-Signal Chat

**Date:** 2026-06-12
**Status:** Accepted
**Supersedes:** N/A

## Problem

List-scoped SignalChat sends full Transcriptions for every signal in the filtered set to the LLM. With no token budget awareness, a 20-signal filter produces ~300K input characters (~75K tokens). The LLM's attention computation scales O(n²), making responses slow and increasingly so with each additional signal. Reducing signal count is not an option (users need all signals in scope). Summaries-only loses detail needed for precise answers.

## Decision

Add a **CompactTranscription** — a telegraphically compressed version of each Transcription, produced by the LLM during Signal analysis via the same call that generates Summary + Sentiment. Multi-signal chat uses CompactTranscriptions instead of full Transcriptions in the PromptAssembler.

### Specification

- **When:** Produced during Poll analysis, piggybacking on the existing `analyzeSignal` LLM call. Zero additional HTTP round-trips — one extra JSON key (`compact_text`) added to the merged LLM response alongside title, summary, takeaways, sentiment, and entities.
- **Format:** Telegraphic text — filler words, function words (articles, prepositions, auxiliary verbs), and punctuation removed. Content words (nouns, main verbs, adjectives, proper names, numbers) preserved in original word order. `[T:ss]` timestamp markers preserved for citation pill compatibility. Negation words ("not", "no", "never") always kept since they change meaning.
- **Compression rules:** Instruction-based — the LLM prompt instructs it to remove filler/function words and punctuation while keeping content words. No hardcoded stopword list used (the LLM handles grammatical categories more robustly than any fixed list).
- **Storage:** New column `signals.compact_text TEXT` (nullable). NULL until analyzed with the extended prompt.
- **Consumption:** Multi-signal chat uses `compact_text` in `formatSignalBlock()` instead of full Transcription. Per-signal chat continues to use full Transcriptions for detail.
- **Backfill:** Existing signals without `compact_text` will be backfilled via a separate script (out of scope for this ADR).

### Expected Impact

~50-60% token reduction for multi-signal chat prompts. For 20 signals: ~75K tokens → ~30-37K tokens. Eliminates the O(n²) attention penalty on the largest prompts while preserving semantic content and timestamp navigability.

## Consequences

### Positive
- **No new LLM calls** — compression is free (piggybacks on existing analysis call).
- **No external dependencies** — uses instruction-based compression, not a separate NLP library or embedding model.
- **Timestamps preserved** — `[T:ss]` markers survive compression, so citation pills in chat answers continue to work.
- **Per-signal chat unaffected** — full Transcriptions still available for detailed single-signal Q&A.

### Negative
- **Schema change required** — new column on `signals` table.
- **Backfill needed** — existing signals have NULL `compact_text` until re-analyzed or backfilled.
- **Information loss** — telegraphic text is not a perfect representation. Some nuance in function words may be lost (mitigated by instruction-based rules that preserve negation).

## Alternatives Considered and Rejected

1. **E2 Synthetic Notation (machine DSL)** — Higher compression (~75-80%) but requires the LLM to decode a custom notation format, adding uncertainty about decoding fidelity.
2. **Language Translation** — Translating to Chinese for character density. Tokenizers produce similar token counts across languages because meaning density does not change with surface representation.
3. **Binary / Pre-tokenized Input** — Not viable with the OpenAI-compatible HTTP API seam (text-only input).
4. **RAG with Vector Retrieval** — Requires embedding model + vector store (new external dependencies). Overkill for the current scale (~20-50 signals per filter).
5. **Hardcoded stopword list** — Less robust than instruction-based compression. The LLM handles edge cases (negation, context-dependent function words) better than any fixed list.