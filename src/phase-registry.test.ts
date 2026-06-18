import { describe, expect, it } from 'vitest';
import { PhaseRegistry, type LlmPhase, type PhaseEntry } from './phase-registry';

describe('PhaseRegistry', () => {
  it('set() stores phase and tokenCount for a given key', () => {
    const registry = new PhaseRegistry<string>();
    registry.set('chat-1', 'intake', 0);

    const entry = registry.get('chat-1');
    expect(entry).toBeDefined();
    expect(entry!.phase).toBe('intake');
    expect(entry!.tokenCount).toBe(0);
  });

  it('set() overwrites existing entry with new phase and tokenCount', () => {
    const registry = new PhaseRegistry<string>();
    registry.set('chat-1', 'intake', 0);
    registry.set('chat-1', 'reasoning', 42);

    const entry = registry.get('chat-1');
    expect(entry!.phase).toBe('reasoning');
    expect(entry!.tokenCount).toBe(42);
  });

  it('get() returns undefined for missing keys', () => {
    const registry = new PhaseRegistry<string>();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('delete() removes entry, subsequent get returns undefined', () => {
    const registry = new PhaseRegistry<string>();
    registry.set('chat-1', 'answering', 100);
    registry.delete('chat-1');

    expect(registry.get('chat-1')).toBeUndefined();
  });

  it('handles multiple concurrent entries independently', () => {
    const registry = new PhaseRegistry<string>();

    registry.set('chat-1', 'intake', 0);
    registry.set('chat-2', 'reasoning', 50);
    registry.set('chat-3', 'answering', 200);

    expect(registry.get('chat-1')!.phase).toBe('intake');
    expect(registry.get('chat-1')!.tokenCount).toBe(0);

    expect(registry.get('chat-2')!.phase).toBe('reasoning');
    expect(registry.get('chat-2')!.tokenCount).toBe(50);

    expect(registry.get('chat-3')!.phase).toBe('answering');
    expect(registry.get('chat-3')!.tokenCount).toBe(200);
  });

  it('supports all LlmPhase values', () => {
    const registry = new PhaseRegistry<string>();
    const phases: LlmPhase[] = ['intake', 'reasoning', 'answering', 'done'];

    for (const phase of phases) {
      registry.set(phase, phase, 0);
      expect(registry.get(phase)!.phase).toBe(phase);
    }
  });

  it('works with numeric keys', () => {
    const registry = new PhaseRegistry<number>();

    registry.set(1, 'intake', 0);
    registry.set(2, 'done', 999);

    expect(registry.get(1)!.phase).toBe('intake');
    expect(registry.get(2)!.tokenCount).toBe(999);
    expect(registry.get(3)).toBeUndefined();
  });

  it('PhaseEntry type has phase and tokenCount properties', () => {
    const entry: PhaseEntry = { phase: 'done', tokenCount: 42 };
    expect(entry.phase).toBe('done');
    expect(entry.tokenCount).toBe(42);
  });
});