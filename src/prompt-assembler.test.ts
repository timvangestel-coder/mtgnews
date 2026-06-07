import { describe, it, expect } from 'vitest';
import { assemble, assembleChat, formatTranscription, defaultPromptTemplate, defaultChatPromptTemplate } from './prompt-assembler';
import type { SignalContext } from './signal-context';
import type { ChatContext } from './prompt-assembler';

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

describe('defaultChatPromptTemplate', () => {
  it('returns a template with chat XML placeholder tags', () => {
    const template = defaultChatPromptTemplate();
    expect(template).toContain('{TRANSCRIPTION}');
    expect(template).toContain('{SUMMARY}');
    expect(template).toContain('{HISTORY}');
    expect(template).toContain('{QUESTION}');
  });

  it('includes analyst role instruction', () => {
    const template = defaultChatPromptTemplate();
    expect(template.toLowerCase()).toContain('analyst');
  });

  it('includes timestamp format instructions', () => {
    const template = defaultChatPromptTemplate();
    expect(template).toContain('T:ss');
  });
});

describe('assembleChat with empty history', () => {
  it('renders chat prompt with transcription, summary, and question', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 10000, text: 'mtg update' }]),
      summary: 'A video about MTG updates',
      history: [],
      question: 'What sets were mentioned?',
    };

    const result = assembleChat(context);

    expect(result).toContain('[T:10] mtg update');
    expect(result).toContain('A video about MTG updates');
    expect(result).toContain('What sets were mentioned?');
  });

  it('omits history section when history is empty', () => {
    const context: ChatContext = {
      transcriptionJson: 'plain text',
      summary: 'summary',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context);

    expect(result).not.toContain('<exchange>');
  });
});

describe('assembleChat with multiple history exchanges', () => {
  it('formats each exchange as nested XML blocks', () => {
    const context: ChatContext = {
      transcriptionJson: 'transcript',
      summary: 'summary text',
      history: [
        { question: 'First question', answer: 'First answer' },
        { question: 'Second question', answer: 'Second answer' },
      ],
      question: 'Third question',
    };

    const result = assembleChat(context);

    expect(result).toContain('<exchange>');
    expect(result).toContain('<question>First question</question>');
    expect(result).toContain('<answer>First answer</answer>');
    expect(result).toContain('<question>Second question</question>');
    expect(result).toContain('<answer>Second answer</answer>');
    // Current question is NOT in history section
    expect(result).toContain('Third question');
  });

  it('renders exchanges in order', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [
        { question: 'Q1', answer: 'A1' },
        { question: 'Q2', answer: 'A2' },
        { question: 'Q3', answer: 'A3' },
      ],
      question: 'Q4',
    };

    const result = assembleChat(context);

    const q1Index = result.indexOf('Q1');
    const q2Index = result.indexOf('Q2');
    const q3Index = result.indexOf('Q3');

    expect(q1Index).toBeLessThan(q2Index);
    expect(q2Index).toBeLessThan(q3Index);
  });
});

describe('assembleChat with custom template', () => {
  it('uses custom template when provided', () => {
    const context: ChatContext = {
      transcriptionJson: 'data',
      summary: 'sum',
      history: [],
      question: 'q?',
    };

    const customTemplate = 'CUSTOM: {TRANSCRIPTION} | {SUMMARY} | {QUESTION}';
    const result = assembleChat(context, customTemplate);

    expect(result).toContain('CUSTOM:');
    expect(result).toContain('data');
    expect(result).toContain('sum');
    expect(result).toContain('q?');
  });

  it('replaces all placeholders in custom template', () => {
    const context: ChatContext = {
      transcriptionJson: 'trans',
      summary: 'summ',
      history: [{ question: 'hq', answer: 'ha' }],
      question: 'final q',
    };

    const customTemplate = '{TRANSCRIPTION}{SUMMARY}{HISTORY}{QUESTION}';
    const result = assembleChat(context, customTemplate);

    expect(result).not.toContain('{TRANSCRIPTION}');
    expect(result).not.toContain('{SUMMARY}');
    expect(result).not.toContain('{HISTORY}');
    expect(result).not.toContain('{QUESTION}');
  });
});

describe('assembleChat is pure', () => {
  it('returns same output for same input with no side effects', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q',
    };

    const a = assembleChat(context);
    const b = assembleChat(context);

    expect(a).toBe(b);
  });
});
