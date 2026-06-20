/**
 * PhaseRegistry — a generic in-memory module for tracking LLM phase progress.
 *
 * Provides type-safe set/get/delete operations keyed by any type K.
 * Each entry tracks the current phase and associated token count.
 */

export type LlmPhase = 'intake' | 'reasoning' | 'answering' | 'retrieving' | 'done';

export interface PhaseEntry {
  phase: LlmPhase;
  tokenCount: number;
  /** Agent loop round number (increments when intake fires, indicating a new processing cycle). */
  round: number;
}

export class PhaseRegistry<K> {
  private entries = new Map<K, PhaseEntry>();

  set(id: K, phase: LlmPhase, tokenCount: number): void {
    const existing = this.entries.get(id);
    // Increment round when intake fires and we already have data (new agent loop iteration)
    const round = (phase === 'intake' && existing !== undefined && existing.round > 0)
      ? existing.round + 1
      : existing?.round ?? 1;
    this.entries.set(id, { phase, tokenCount, round });
  }

  get(id: K): PhaseEntry | undefined {
    return this.entries.get(id);
  }

  delete(id: K): void {
    this.entries.delete(id);
  }

  /** Return all entries as an array of [key, value] pairs */
  getAll(): Array<[K, PhaseEntry]> {
    return Array.from(this.entries.entries());
  }
}
