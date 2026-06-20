import { describe, it, expect } from 'vitest';
import { assemble, assembleChat, formatTranscription, defaultPromptTemplate, defaultChatPromptTemplate, assembleMultiSignalChat, defaultMultiSignalChatPromptTemplate, assembleAgentChat, defaultAgentChatPromptTemplate, type FormatStyle } from './prompt-assembler';
import type { SignalContext } from './signal-context';
import type { ChatContext } from './prompt-assembler';
import type { ChatSignalContext } from './signal-chat-scope';

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

function makeChatSignal(overrides: Partial<ChatSignalContext> = {}): ChatSignalContext {
  return {
    signalContext: {
      transcriptionJson: JSON.stringify([{ time: 10000, text: 'signal content' }]),
      topicId: 1,
      filterText: 'Magic cards',
      summaryPrompt: null,
    },
    videoId: 'vid_1',
    title: 'Test Video',
    channelDisplayName: 'Test Channel',
    ...overrides,
  };
}

describe('defaultMultiSignalChatPromptTemplate', () => {
  it('returns a template with signal placeholder and grouping instruction', () => {
    const template = defaultMultiSignalChatPromptTemplate();
    expect(template).toContain('{SIGNALS}');
    expect(template).toContain('{QUESTION}');
    // Fixed: removed conflicting <videoId:T:ss> citation format; now instructs grouping by source
    expect(template).toMatch(/Group findings by source/i);
  });

  it('includes instruction to not add inline citations', () => {
    const template = defaultMultiSignalChatPromptTemplate();
    expect(template).toMatch(/do not.*inline.*citation/i);
  });
});

describe('assembleMultiSignalChat with multiple signals', () => {
  it('produces valid prompt with XML signal blocks', () => {
    const context = {
      signals: [makeChatSignal(), makeChatSignal({ videoId: 'vid_2', title: 'Video Two' })],
      history: [],
      question: 'What cards were mentioned?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('<signals>');
    expect(result).toContain('</signals>');
    expect(result).toContain('signal video_id=');
    expect(result).toContain('</signal>');
  });

  it('each signal block includes video_id, title, transcription, and summary', () => {
    const context = {
      signals: [makeChatSignal({
        signalContext: { ...makeChatSignal().signalContext, transcriptionJson: JSON.stringify([{ time: 5000, text: 'hello' }]) },
      })],
      history: [],
      question: 'q?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('video_id="vid_1"');
    expect(result).toContain('title="Test Video"');
    expect(result).toContain('[T:5] hello');
  });
});

describe('assembleMultiSignalChat with single signal', () => {
  it('wraps single signal in signals block', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [],
      question: 'What is this about?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('<signals>');
    expect(result).toContain('signal video_id=');
    expect(result).toContain('</signal>');
    expect(result).toContain('What is this about?');
  });
});

describe('assembleMultiSignalChat with empty signals array', () => {
  it('produces prompt with empty signals block', () => {
    const context = {
      signals: [],
      history: [],
      question: 'Any news?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('<signals></signals>');
    expect(result).toContain('Any news?');
  });
});

describe('assembleMultiSignalChat with history', () => {
  it('includes history exchanges in the prompt', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [{ question: 'Previous Q', answer: 'Previous A' }],
      question: 'Current Q',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('<history>');
    expect(result).toContain('Previous Q');
    expect(result).toContain('Previous A');
    expect(result).toContain('Current Q');
  });
});

describe('assembleMultiSignalChat with custom template', () => {
  it('uses custom template when provided', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [],
      question: 'q?',
    };

    const result = assembleMultiSignalChat(context, 'MY TEMPLATE: {SIGNALS} | {QUESTION}');

    expect(result).toContain('MY TEMPLATE:');
    expect(result).toContain('q?');
  });
});

describe('assembleMultiSignalChat is pure', () => {
  it('returns same output for same input with no side effects', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [],
      question: 'q?',
    };

    const a = assembleMultiSignalChat(context);
    const b = assembleMultiSignalChat(context);

    expect(a).toBe(b);
  });
});

// Bug 2 (issue #137): filter_text support in multi-signal prompt
describe('Bug 137 — filter_text in multi-signal prompt', () => {
  it('default template includes {FILTER_TEXT} placeholder', () => {
    const template = defaultMultiSignalChatPromptTemplate();
    expect(template).toContain('{FILTER_TEXT}');
  });

  it('assembleMultiSignalChat replaces {FILTER_TEXT} with provided value', () => {
    const context = {
      signals: [makeChatSignal()],
      filterText: 'Magic: The Gathering news and updates',
      history: [],
      question: 'q?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('Magic: The Gathering news and updates');
    expect(result).not.toContain('{FILTER_TEXT}');
  });

  it('assembleMultiSignalChat replaces {FILTER_TEXT} with empty string when not provided', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [],
      question: 'q?',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).not.toContain('{FILTER_TEXT}');
  });
});

// Bug 1: formatSignalBlock uses signal.summary, not summaryPrompt
describe('Bug 1 — signal block uses actual summary', () => {
  it('uses signal.summary field instead of summaryPrompt in <summary> tag', () => {
    const signal = makeChatSignal({
      signalContext: {
        transcriptionJson: JSON.stringify([{ time: 0, text: 'x' }]),
        topicId: 1,
        filterText: '',
        summaryPrompt: 'THIS IS A PROMPT TEMPLATE - NOT THE SUMMARY',
      },
      summary: 'This is the real AI-generated summary',
    });

    const result = assembleMultiSignalChat({ signals: [signal], history: [], question: 'q?' });

    // Should contain the actual summary, not the prompt template
    expect(result).toContain('This is the real AI-generated summary');
    expect(result).not.toContain('THIS IS A PROMPT TEMPLATE');
  });

  it('renders empty summary when signal.summary is undefined', () => {
    const signal = makeChatSignal({
      signalContext: {
        transcriptionJson: JSON.stringify([{ time: 0, text: 'x' }]),
        topicId: 1,
        filterText: '',
        summaryPrompt: null,
      },
    });

    const result = assembleMultiSignalChat({ signals: [signal], history: [], question: 'q?' });

    expect(result).toContain('<summary></summary>');
  });
});

// Bug 2: citation format instruction — REMOVED conflicting <videoId:T:ss> format
// The multi-signal template no longer instructs angle-bracket citations because they conflict
// with FORMAT_INSTRUCTIONS' "do not append citation markers" rule. Instead it instructs
// grouping by source, and the FORMAT_INSTRUCTIONS provide concrete table examples.
describe('Bug 2 — citation format instruction removed (conflict fix)', () => {
  it('default template does NOT include <videoId:T:ss> angle bracket format', () => {
    const template = defaultMultiSignalChatPromptTemplate();

    // Must NOT have angle-bracket citation format that conflicts with FORMAT_INSTRUCTIONS
    expect(template).not.toMatch(/<[^>]+:T:\d+>/);
  });

  it('default template instructs grouping by source instead of inline citations', () => {
    const template = defaultMultiSignalChatPromptTemplate();

    // Should instruct grouping, not angle-bracket citations
    expect(template).toMatch(/Group findings by source/i);
    expect(template).toMatch(/do not.*inline.*citation/i);
  });
});

// Bug 3 (issue #137): strip HTML from history answers before injecting into LLM prompt
describe('Bug 137 — strip HTML from history answers', () => {
  it('strips HTML tags from history answers in multi-signal chat', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [{
        question: 'Previous Q',
        answer: '<a href="/signals/abc#t-120" rel="nofollow">Title · [02:00]</a> some text',
      }],
      question: 'Current Q',
    };

    const result = assembleMultiSignalChat(context);

    // Stripped content should remain
    expect(result).toContain('Title');
    expect(result).toContain('[02:00]');
    expect(result).toContain('some text');
    // HTML tags should be stripped from the prompt
    expect(result).not.toContain('<a href=');
    expect(result).not.toContain('rel="nofollow"');
  });

  it('strips HTML tags from history answers in single-signal chat', () => {
    const context: ChatContext = {
      transcriptionJson: 'transcript',
      summary: 'summary',
      history: [{
        question: 'Q1',
        answer: '<span class="pill">formatted</span> plain text',
      }],
      question: 'Q2',
    };

    const result = assembleChat(context);

    expect(result).toContain('formatted');
    expect(result).toContain('plain text');
    // HTML tags stripped
    expect(result).not.toContain('<span class="pill">');
  });

  it('leaves plain text history answers unchanged', () => {
    const context = {
      signals: [makeChatSignal()],
      history: [{ question: 'Q1', answer: 'Plain text answer with no HTML' }],
      question: 'Q2',
    };

    const result = assembleMultiSignalChat(context);

    expect(result).toContain('Plain text answer with no HTML');
  });
});

describe('assembleChat regression', () => {
  it('existing assembleChat behavior unchanged', () => {
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
});

// Issue #152: ResponseFormat — FORMAT_INSTRUCTIONS placeholder
describe('Issue 152 — formatStyle in assembleChat', () => {
  it('default template includes {FORMAT_INSTRUCTIONS} placeholder', () => {
    const template = defaultChatPromptTemplate();
    expect(template).toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleChat replaces {FORMAT_INSTRUCTIONS} with value for "annotated-index" style', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).not.toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleChat replaces {FORMAT_INSTRUCTIONS} with empty string for "plain" style', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'plain');

    expect(result).not.toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleChat defaults formatStyle to "annotated-index" when not provided', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const resultDefault = assembleChat(context);
    const resultExplicit = assembleChat(context, undefined, 'annotated-index');

    expect(resultDefault).toBe(resultExplicit);
  });
});

describe('Issue 152 — formatStyle in assembleMultiSignalChat', () => {
  it('default multi-signal template includes {FORMAT_INSTRUCTIONS} placeholder', () => {
    const template = defaultMultiSignalChatPromptTemplate();
    expect(template).toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleMultiSignalChat replaces {FORMAT_INSTRUCTIONS} with value for "annotated-index"', () => {
    const signal = makeChatSignal();

    const result = assembleMultiSignalChat(
      { signals: [signal], history: [], question: 'q?' },
      undefined,
      'annotated-index'
    );

    expect(result).not.toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleMultiSignalChat replaces {FORMAT_INSTRUCTIONS} with empty string for "plain"', () => {
    const signal = makeChatSignal();

    const result = assembleMultiSignalChat(
      { signals: [signal], history: [], question: 'q?' },
      undefined,
      'plain'
    );

    expect(result).not.toContain('{FORMAT_INSTRUCTIONS}');
  });

  it('assembleMultiSignalChat defaults formatStyle to "annotated-index" when not provided', () => {
    const signal = makeChatSignal();

    const resultDefault = assembleMultiSignalChat({ signals: [signal], history: [], question: 'q?' });
    const resultExplicit = assembleMultiSignalChat(
      { signals: [signal], history: [], question: 'q?' },
      undefined,
      'annotated-index'
    );

    expect(resultDefault).toBe(resultExplicit);
  });
});

// Issue #148: compactText support in per-signal chat
describe('Issue 148 — compactText in assembleChat', () => {
  it('prefers compactText over formatted transcription when available', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 0, text: 'so um you know the Kaldra set is not bad at all and we talked about it for a long time' }]),
      summary: 'Discussion about Kaldra set',
      compactText: '[T:0] Kaldra set not bad discussed',
      history: [],
      question: 'What was said about Kaldra?',
    };

    const result = assembleChat(context);

    // Should use compact text, NOT the verbose full transcription
    expect(result).toContain('[T:0] Kaldra set not bad discussed');
    expect(result).not.toContain('so um you know');
  });

  it('falls back to formatted transcription when compactText is undefined', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 42000, text: 'full transcript segment' }]),
      summary: 'summary',
      // compactText not provided
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context);

    expect(result).toContain('[T:42] full transcript segment');
  });

  it('falls back to formatted transcription when compactText is null', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 10000, text: 'fallback text' }]),
      summary: 'summary',
      compactText: null as unknown as undefined,
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context);

    expect(result).toContain('[T:10] fallback text');
  });

  it('falls back to formatted transcription when compactText is empty string', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 5000, text: 'fallback on empty' }]),
      summary: 'summary',
      compactText: '',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context);

    // Empty string is falsy, should fall back to formatted transcription
    expect(result).toContain('[T:5] fallback on empty');
  });
});

// Issue #146: CompactTranscription wired into PromptAssembler for multi-signal chat
describe('Issue 146 — compactText in multi-signal signal blocks', () => {
  it('uses compactText in <content> tag when available', () => {
    const signal = makeChatSignal({
      compactText: '[T:10] MTG update new set announcement',
    });

    const result = assembleMultiSignalChat({ signals: [signal], history: [], question: 'q?' });

    // Should use <content> tag with compact text, not full transcription
    expect(result).toContain('<content>');
    expect(result).toContain('[T:10] MTG update new set announcement');
    // Full transcription "[T:10] signal content" should NOT appear in <content> block
    expect(result).not.toContain('<content>[T:10] signal content</content>');
  });

  it('falls back to formatted transcription in <content> when compactText is undefined', () => {
    const signal = makeChatSignal({
      signalContext: {
        ...makeChatSignal().signalContext,
        transcriptionJson: JSON.stringify([{ time: 42000, text: 'full transcript segment' }]),
      },
      // compactText not set
    });

    const result = assembleMultiSignalChat({ signals: [signal], history: [], question: 'q?' });

    // Should fall back to formatted transcription in <content> tag
    expect(result).toContain('<content>');
    expect(result).toContain('[T:42] full transcript segment');
  });

  it('mixed signals: some with compactText, some without', () => {
    const signalWithCompact = makeChatSignal({
      videoId: 'vid_compact',
      title: 'Compact Video',
      compactText: '[T:5] compressed text only',
    });

    const signalWithoutCompact = makeChatSignal({
      videoId: 'vid_full',
      title: 'Full Video',
      signalContext: {
        ...makeChatSignal().signalContext,
        transcriptionJson: JSON.stringify([{ time: 100000, text: 'full transcript' }]),
      },
    });

    const result = assembleMultiSignalChat({
      signals: [signalWithCompact, signalWithoutCompact],
      history: [],
      question: 'q?',
    });

    // Compact signal uses compactText
    expect(result).toContain('video_id="vid_compact"');
    expect(result).toContain('[T:5] compressed text only');

    // Full signal falls back to formatted transcription
    expect(result).toContain('video_id="vid_full"');
    expect(result).toContain('[T:100] full transcript');
  });

  it('assembleChat per-signal path unchanged — still uses <transcription> with full text', () => {
    const context: ChatContext = {
      transcriptionJson: JSON.stringify([{ time: 30000, text: 'per signal chat' }]),
      summary: 'summary',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context);

    // Per-signal chat still uses <transcription> tag (not <content>)
    expect(result).toContain('<transcription>');
    expect(result).toContain('[T:30] per signal chat');
  });
});

// =============================================================================
// Regression: issue-153 — FORMAT_INSTRUCTIONS[annotated-index] populated
// =============================================================================

describe('Regression: issue-153 — annotated-index format instructions', () => {
  it('assembled chat prompt contains table syntax instruction for annotated-index format', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/\| Timestamp \| Finding \|/);
    expect(result).toMatch(/\|-----------\|---------\|/);
    expect(result).toMatch(/\[MM:SS\]/);
  });

  it('assembled chat prompt contains bold source title instruction', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/\*\*.*[Ss]ource\s+Title/i);
    expect(result).toMatch(/bold.*text.*above.*table/i);
  });

  it('assembled chat prompt contains no-inline-citation instruction', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/do\s*not.*cit/i);
  });

  it('assembled chat prompt contains conciseness constraints', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/\b\d+\s*words?/i);
  });

  it('plain style still produces empty format instructions (no regression)', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'plain');

    expect(result).not.toMatch(/markdown\s*table/i);
  });

  it('multi-signal assembled prompt contains same format instructions as single-signal', () => {
    function makeChatSignal(): import('./signal-chat-scope').ChatSignalContext {
      return {
        signalContext: {
          transcriptionJson: JSON.stringify([{ time: 10000, text: 'signal content' }]),
          topicId: 1,
          filterText: 'Magic cards',
          summaryPrompt: null,
        },
        videoId: 'vid_1',
        title: 'Test Video',
        channelDisplayName: 'Test Channel',
      };
    }

    const signal = makeChatSignal();

    const result = assembleMultiSignalChat(
      { signals: [signal], history: [], question: 'q?' },
      undefined,
      'annotated-index'
    );

    expect(result).toMatch(/\| Timestamp \| Finding \|/);
    expect(result).toMatch(/\*\*.*[Ss]ource\s+Title/i);
    expect(result).toMatch(/do\s*not.*cit/i);
    expect(result).toMatch(/Group findings by source/i);
  });
});

// =============================================================================
// Regression: issue-163 — assembleAgentChat lightweight index
// =============================================================================

describe('Regression: issue-163 — assembleAgentChat', () => {
  function makeIndexEntry(overrides: Partial<import('./prompt-assembler').SignalIndexEntry> = {}): import('./prompt-assembler').SignalIndexEntry {
    return {
      videoId: 'vid_1',
      title: 'Test Video Title',
      summary: 'This is a concise summary of the video content for agent retrieval.',
      ...overrides,
    };
  }

  it('template has signal index and question placeholders', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toContain('{SIGNAL_INDEX}');
    expect(template).toContain('{QUESTION}');
    expect(template).toMatch(/get_compact_text/i);
  });

  it('produces XML signal index block with video_id, title, summary', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'What cards were mentioned?',
      []
    );

    expect(result).toContain('<signal_index>');
    expect(result).toContain('video_id="vid_1"');
    expect(result).not.toContain('<transcription>');
  });

  it('produces XML block for each signal in scope', () => {
    const entries = [
      makeIndexEntry({ videoId: 'vid_1', title: 'Video One', summary: 'Summary one' }),
      makeIndexEntry({ videoId: 'vid_2', title: 'Video Two', summary: 'Summary two' }),
    ];

    const result = assembleAgentChat(entries, 'Compare these videos', []);

    expect(result).toContain('video_id="vid_1"');
    expect(result).toContain('video_id="vid_2"');
  });

  it('includes history exchanges in XML format', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'What about Innistrad?',
      [{ question: 'Previous Q', answer: 'Previous A' }]
    );

    expect(result).toContain('<history>');
    expect(result).not.toContain('<a href=');
  });

  it('strips HTML from history answers', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'Current Q',
      [{ question: 'Previous Q', answer: '<a href="/signals/abc">Title</a> plain text' }]
    );

    expect(result).toContain('Title');
    expect(result).not.toContain('<a href=');
  });

  it('produces prompt with empty signal index block when signals array is empty', () => {
    const result = assembleAgentChat([], 'Any news?', []);

    expect(result).toContain('<signal_index>');
    expect(result).toContain('</signal_index>');
  });

  it('uses custom template over default', () => {
    const custom = 'AGENT: {SIGNAL_INDEX} Q:{QUESTION}';
    const result = assembleAgentChat([makeIndexEntry()], 'q?', [], custom);

    expect(result).toContain('AGENT:');
    expect(result).not.toContain('content analyst');
  });
});
