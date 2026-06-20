import { describe, it, expect } from 'vitest';
import { ChatResponseFormatterImpl } from './chat-response-formatter';
import { assembleChat, assembleMultiSignalChat } from './prompt-assembler';
import type { ChatContext } from './prompt-assembler';
import type { ChatSignalContext } from './signal-chat-scope';

// =============================================================================
// Issue #153: Implement annotated-index format instructions in ResponseFormat
// =============================================================================

describe('Issue 153 — Integration: citation pills inside markdown table cells', () => {
  const formatter = new ChatResponseFormatterImpl();

  it('T:ss timestamps inside GFM table cells produce valid <table> HTML with working pill links inside <td> cells', () => {
    const signalMap = { vid_abc123: { title: 'Source Video' } };
    // Use <videoId:T:ss> citations in table so timestamps inherit videoId context
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| <vid_abc123:T:142> S&P 500 correction expected |',
      '| T:734 Broad index funds strategy |'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    // Must render as a valid HTML table
    expect(result).toContain('<table>');
    expect(result).toContain('</table>');
    expect(result).toContain('<tr>');

    // First row: full pill with videoId from citation
    expect(result).toContain('href="/signals/vid_abc123#t-142000"');
    expect(result).toContain('[02:22]');  // 142 seconds = 02:22

    // Second row: T:734 inherits vid_abc123 from previous citation
    expect(result).toContain('href="/signals/vid_abc123#t-734000"');
    expect(result).toContain('[12:14]');  // 734 seconds = 12:14

    // Finding text must be present in table cells (& is HTML-escaped)
    const amp = String.fromCharCode(38);
    expect(result).toContain('S' + amp + 'amp;P 500 correction expected');
    expect(result).toContain('Broad index funds strategy');
  });

  it('bare T:ss timestamps before any citation use fragment-only fallback inside table cells', () => {
    const signalMap = { vid_abc123: { title: 'Source Video' } };
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| T:142 | S&P 500 correction expected |',
      '| T:734 | Broad index funds strategy |'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    // Must render as a valid HTML table
    expect(result).toContain('<table>');
    expect(result).toContain('</table>');

    // Bare timestamps before any citation get fragment-only fallback
    expect(result).toContain('href="#t-142000"');
    expect(result).toContain('href="#t-734000"');
    expect(result).toContain('[02:22]');
    expect(result).toContain('[12:14]');

    // Finding text present (& is HTML-escaped)
    const amp2 = String.fromCharCode(38);
    expect(result).toContain('S' + amp2 + 'amp;P 500 correction expected');
  });

  it('<videoId:T:ss> citations inside table cells produce full pill links', () => {
    const signalMap = { vid_xyz: { title: 'My Video' } };
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| <vid_xyz:T:60> | Important finding |'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    expect(result).toContain('<table>');
    expect(result).toContain('href="/signals/vid_xyz#t-60000"');
    expect(result).toContain('My Video');
    expect(result).toContain('[01:00]');
  });

  it('mixed citation styles in table cells all produce pills', () => {
    const signalMap = { v1: { title: 'Video A' }, v2: { title: 'Video B' } };
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| <v1:T:30> | First finding |',
      '| T:90 | Second finding with inherited video |',
      '| <v2:T:200> | Third from different video |'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    expect(result).toContain('<table>');
    // v1 citation
    expect(result).toContain('href="/signals/v1#t-30000"');
    expect(result).toContain('Video A');
    // T:90 inherits v1 (last seen videoId)
    expect(result).toContain('href="/signals/v1#t-90000"');
    // v2 citation
    expect(result).toContain('href="/signals/v2#t-200000"');
    expect(result).toContain('Video B');
  });

  it('table with thematic tags line survives markdown processing', () => {
    const signalMap = { vid1: { title: 'V' } };
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| T:10 | Key point |',
      '',
      'cyclusvergelijking · diversificatie · IPO-impact'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    expect(result).toContain('<table>');
    expect(result).toContain('href="#t-10000"');  // no video context before table → fragment fallback
    expect(result).toContain('cyclusvergelijking');
  });
});

describe('Issue 153 — FORMAT_INSTRUCTIONS[annotated-index] populated', () => {
  it('assembled chat prompt contains table syntax instruction for annotated-index format', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    // Must contain concrete table example with header row and separator row
    expect(result).toMatch(/\| Timestamp \| Finding \|/);
    expect(result).toMatch(/\|-----------\|---------\|/);
    // Table columns should use [MM:SS] format converted from T:ss markers in the source
    expect(result).toMatch(/\[MM:SS\]/);
  });

  it('assembled chat prompt contains bold source title instruction (not ### heading)', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    // Must instruct about **Source Title** bold format via concrete example
    expect(result).toMatch(/\*\*.*[Ss]ource\s+Title/i);
    // The instruction says "NOT a markdown heading (no ###)" — the literal string "###" appears
    // in the negative instruction, so we check the positive: it must say bold, not heading
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

    // Must explicitly tell LLM NOT to append citations after findings
    expect(result).toMatch(/do\s*not.*cit/i);
  });

  it('assembled chat prompt contains thematic tags instruction', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/tag/i);
  });

  it('assembled chat prompt contains 1-sentence summary instruction', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toMatch(/summary/i);
  });

  it('assembled chat prompt contains T:ss format rule', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    expect(result).toContain('T:ss');
  });

  it('assembled chat prompt contains conciseness constraints (max words per finding)', () => {
    const context: ChatContext = {
      transcriptionJson: 't',
      summary: 's',
      history: [],
      question: 'q?',
    };

    const result = assembleChat(context, undefined, 'annotated-index');

    // Must contain hard word limit for findings
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

    // plain style should have empty format instructions (no structural content)
    expect(result).not.toMatch(/markdown\s*table/i);
  });
});

describe('Timestamp accuracy regression — LLM no longer does arithmetic conversion', () => {
  const formatter = new ChatResponseFormatterImpl();

  it('LLM outputs [T:ss] which formatter converts to correct MM:SS display and exact ms deep link', () => {
    // The fix: FORMAT_INSTRUCTIONS now tell LLM to use [T:ss] format (copy exact number)
    // instead of [MM:SS] format (which required LLM arithmetic that produced errors like [31:61]).
    // ChatResponseFormatter handles all conversion deterministically.
    const signalMap = { vid_abc: { title: 'Test Video' } };

    // Simulate LLM output using [T:ss] format under heading context
    const result = formatter.format(
      '**Test Video**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:1921]  | Space solar power shifts to infrared beaming |',
      signalMap
    );

    // The [T:1921] should convert to [32:01] display (1921/60 = 32min, 1921%60 = 1sec)
    expect(result).toContain('[32:01]');
    // Deep link should use exact ms: 1921 * 1000 = 1921000
    expect(result).toContain('href="/signals/vid_abc#t-1921000"');
    expect(result).toContain('data-timestamp="1921000"');
    // Should NOT produce invalid display like [31:61]
    expect(result).not.toContain('[31:61]');
  });

  it('large T:ss values convert correctly without LLM arithmetic errors', () => {
    const signalMap = { vid_x: { title: 'V' } };

    // T:1602 should be [26:42], not [26:72] (old LLM error pattern)
    const result = formatter.format(
      '**V**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:1602]  | Universal constants simulated parameters |',
      signalMap
    );

    expect(result).toContain('[26:42]');
    expect(result).toContain('href="/signals/vid_x#t-1602000"');
    expect(result).not.toContain('[26:72]');
  });
});

describe('Issue 153 — multi-signal chat uses same annotated-index instructions', () => {
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

  it('multi-signal assembled prompt contains same format instructions as single-signal', () => {
    const signal = makeChatSignal();

    const result = assembleMultiSignalChat(
      { signals: [signal], history: [], question: 'q?' },
      undefined,
      'annotated-index'
    );

    // Same structural elements: concrete table example, bold titles, no inline citation duplication
    expect(result).toMatch(/\| Timestamp \| Finding \|/);
    expect(result).toMatch(/\*\*.*[Ss]ource\s+Title/i);
    expect(result).toMatch(/do\s*not.*cit/i);
    // Multi-signal template instructs grouping by source instead of angle-bracket citations
    expect(result).toMatch(/Group findings by source/i);
  });
});