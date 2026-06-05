import { describe, it, expect } from 'vitest';
import { assemble, formatTranscription, defaultPromptTemplate } from './prompt-assembler';
import type { SignalContext } from './signal-context';

function makeContext(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    transcriptionJson: JSON.stringify([{ time: 45000, text: 'hello world' }, { time: 92000, text: 'mtg news' }]),
    topicId: 1,
    filterText: 'Magic cards and sets',
    summaryPrompt: null,
    ...overrides,
  };
}

describe('formatTranscription', () => {
  it('formats segments with time field into [T:ss] text', () => {
    const json = JSON.stringify([{ time: 45000, text: 'hello world' }, { time: 92000, text: 'mtg news' }]);
    expect(formatTranscription(json)).toBe('[T:45] hello world [T:92] mtg news');
  });

  it('formats segments with start field into [T:ss] text', () => {
    const json = JSON.stringify([{ start: 1000, text: 'intro' }, { start: 55000, text: 'main topic' }]);
    expect(formatTranscription(json)).toBe('[T:1] intro [T:55] main topic');
  });

  it('returns plain text when not valid JSON array', () => {
    expect(formatTranscription('just plain text')).toBe('just plain text');
  });
});

describe('defaultPromptTemplate', () => {
  it('returns a template with XML placeholder tags', () => {
    const template = defaultPromptTemplate();
    expect(template).toContain('<transcription>');
    expect(template).toContain('</transcription>');
    expect(template).toContain('<filter_text>');
    expect(template).toContain('</filter_text>');
  });
});

describe('assemble with custom template', () => {
  it('injects variables into custom template', () => {
    const context = makeContext({
      summaryPrompt: '<transcription>{TRANSCRIPTION}</transcription>\n<filter_text>{FILTER_TEXT}</filter_text>',
    });

    const result = assemble(context);

    expect(result).toContain('[T:45] hello world [T:92] mtg news');
    expect(result).toContain('Magic cards and sets');
  });

  it('does not partially match placeholder names', () => {
    const context = makeContext({
      summaryPrompt: '{TRANSCRIPTION} and {FILTER_TEXT}',
    });

    const result = assemble(context);

    // Both placeholders replaced, no raw placeholders remain
    expect(result).not.toContain('{TRANSCRIPTION}');
    expect(result).not.toContain('{FILTER_TEXT}');
  });
});

describe('assemble with null summaryPrompt', () => {
  it('falls back to default template when summaryPrompt is null', () => {
    const context = makeContext({ summaryPrompt: null });

    const result = assemble(context);

    expect(result).toContain('[T:45] hello world [T:92] mtg news');
    expect(result).toContain('Magic cards and sets');
    expect(result).toContain('content analyst');
  });
});

describe('assemble is pure', () => {
  it('returns same output for same input with no side effects', () => {
    const context = makeContext({ summaryPrompt: null });

    const a = assemble(context);
    const b = assemble(context);

    expect(a).toBe(b);
  });
});