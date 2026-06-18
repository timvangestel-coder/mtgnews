/**
 * PhaseRegistry — a generic in-memory module for tracking LLM phase progress.
 *
 * Provides type-safe set/get/delete operations keyed by any type K.
 * Each entry tracks the current phase and associated token count.
 */

export type LlmPhase = 'intake' | 'reasoning' | 'answering' | 'done';

export interface PhaseEntry {
  phase: LlmPhase;
  tokenCount: number;
}

export class PhaseRegistry<K> {
  private entries = new Map<K, PhaseEntry>();

  set(id: K, phase: LlmPhase, tokenCount: number): void {
    this.entries.set(id, { phase, tokenCount });
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
