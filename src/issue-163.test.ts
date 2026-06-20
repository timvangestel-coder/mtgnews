import { describe, it, expect } from 'vitest';
import { assembleAgentChat, defaultAgentChatPromptTemplate, type SignalIndexEntry } from './prompt-assembler';

// ─── Helpers ──────────────────────────────────────────────────

function makeIndexEntry(overrides: Partial<SignalIndexEntry> = {}): SignalIndexEntry {
  return {
    videoId: 'vid_1',
    title: 'Test Video Title',
    summary: 'This is a concise summary of the video content for agent retrieval.',
    ...overrides,
  };
}

// ─── defaultAgentChatPromptTemplate ──────────────────────────

describe('defaultAgentChatPromptTemplate', () => {
  it('returns a template with signal index placeholder', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toContain('{SIGNAL_INDEX}');
  });

  it('returns a template with question placeholder', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toContain('{QUESTION}');
  });

  it('returns a template with history placeholder', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toContain('{HISTORY}');
  });

  it('includes tool instructions for get_compact_text', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toMatch(/get_compact_text/i);
  });

  it('instructs the LLM to use tool calling for retrieval', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toMatch(/tool/i);
  });
});

// ─── assembleAgentChat with single signal ─────────────────────

describe('assembleAgentChat with single signal', () => {
  it('produces XML signal index block with video_id, title, summary', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'What cards were mentioned?',
      []
    );

    expect(result).toContain('<signal_index>');
    expect(result).toContain('</signal_index>');
    expect(result).toContain('video_id="vid_1"');
    expect(result).toContain('Test Video Title');
    expect(result).toContain('This is a concise summary');
  });

  it('includes the user question', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'What sets were announced?',
      []
    );

    expect(result).toContain('What sets were announced?');
  });

  it('does NOT include compact_text or full transcription in the index', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'q?',
      []
    );

    // Index should be lightweight — no raw transcription content
    expect(result).not.toContain('<transcription>');
    expect(result).not.toContain('<content>');
  });
});

// ─── assembleAgentChat with multiple signals ──────────────────

describe('assembleAgentChat with multiple signals', () => {
  it('produces XML block for each signal in scope', () => {
    const entries = [
      makeIndexEntry({ videoId: 'vid_1', title: 'Video One', summary: 'Summary one' }),
      makeIndexEntry({ videoId: 'vid_2', title: 'Video Two', summary: 'Summary two' }),
      makeIndexEntry({ videoId: 'vid_3', title: 'Video Three', summary: 'Summary three' }),
    ];

    const result = assembleAgentChat(entries, 'Compare these videos', []);

    expect(result).toContain('video_id="vid_1"');
    expect(result).toContain('video_id="vid_2"');
    expect(result).toContain('video_id="vid_3"');
    expect(result).toContain('Video One');
    expect(result).toContain('Summary one');
  });

  it('each signal entry is compact (~50 tokens worth of data)', () => {
    const entries = [
      makeIndexEntry({ videoId: 'v1', title: 'Short Title', summary: 'Brief summary' }),
    ];

    const result = assembleAgentChat(entries, 'q?', []);

    // Each signal block should only have video_id, title, summary — no transcription
    const signalBlock = result.match(/<signal_index>[\s\S]*?<\/signal_index>/)?.[0] ?? '';
    expect(signalBlock).not.toContain('transcription');
    expect(signalBlock).toContain('v1');
  });
});

// ─── assembleAgentChat with history ──────────────────────────

describe('assembleAgentChat with conversation history', () => {
  it('includes history exchanges in XML format', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'What about Innistrad?',
      [{ question: 'Previous Q', answer: 'Previous A' }]
    );

    expect(result).toContain('<history>');
    expect(result).toContain('Previous Q');
    expect(result).toContain('Previous A');
  });

  it('omits history section when history is empty', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'q?',
      []
    );

    expect(result).not.toContain('<exchange>');
  });
});

// ─── assembleAgentChat with custom template ──────────────────

describe('assembleAgentChat with custom template', () => {
  it('uses custom template when provided', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'q?',
      [],
      'CUSTOM: {SIGNAL_INDEX} | {QUESTION}'
    );

    expect(result).toContain('CUSTOM:');
    expect(result).toContain('q?');
  });

  it('replaces all placeholders in custom template', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'final q',
      [{ question: 'hq', answer: 'ha' }],
      '{SIGNAL_INDEX}{HISTORY}{QUESTION}'
    );

    expect(result).not.toContain('{SIGNAL_INDEX}');
    expect(result).not.toContain('{HISTORY}');
    expect(result).not.toContain('{QUESTION}');
  });
});

// ─── assembleAgentChat is pure ──────────────────────────────

describe('assembleAgentChat is pure', () => {
  it('returns same output for same input with no side effects', () => {
    const entries = [makeIndexEntry()];
    const question = 'q?';
    const history: Array<{ question: string; answer: string }> = [];

    const a = assembleAgentChat(entries, question, history);
    const b = assembleAgentChat(entries, question, history);

    expect(a).toBe(b);
  });
});

// ─── Tool instructions in template ──────────────────────────

describe('Tool calling instructions', () => {
  it('template describes get_compact_text tool parameters', () => {
    const template = defaultAgentChatPromptTemplate();
    expect(template).toMatch(/videoId/i);
  });

  it('assembled output includes tool schema reference', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'q?',
      []
    );

    // The assembled prompt should include the tool name so LLM knows what to call
    expect(result).toMatch(/get_compact_text/);
  });
});

// ─── Empty signals edge case ────────────────────────────────

describe('assembleAgentChat with empty signals array', () => {
  it('produces prompt with empty signal index block', () => {
    const result = assembleAgentChat([], 'Any news?', []);

    expect(result).toContain('<signal_index>');
    expect(result).toContain('</signal_index>');
    expect(result).toContain('Any news?');
  });
});

// ─── HTML stripping in history answers ──────────────────────

describe('assembleAgentChat strips HTML from history answers', () => {
  it('removes HTML tags from answer text', () => {
    const result = assembleAgentChat(
      [makeIndexEntry()],
      'Current Q',
      [{ question: 'Previous Q', answer: '<a href="/signals/abc">Title</a> plain text' }]
    );

    expect(result).toContain('Title');
    expect(result).toContain('plain text');
    expect(result).not.toContain('<a href=');
  });
});

// ─── Three-tier template resolution ─────────────────────────

describe('Three-tier template resolution', () => {
  it('falls back to default template when customTemplate is undefined', () => {
    const resultDefault = assembleAgentChat([makeIndexEntry()], 'q?', []);
    const resultExplicit = assembleAgentChat([makeIndexEntry()], 'q?', [], undefined);

    expect(resultDefault).toBe(resultExplicit);
  });

  it('uses custom template over default', () => {
    const custom = 'AGENT: {SIGNAL_INDEX} Q:{QUESTION}';
    const result = assembleAgentChat([makeIndexEntry()], 'q?', [], custom);

    expect(result).toContain('AGENT:');
    // Default template content should NOT appear
    expect(result).not.toContain('content analyst');
  });
});