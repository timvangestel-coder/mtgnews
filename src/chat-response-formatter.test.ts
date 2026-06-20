import { describe, it, expect } from 'vitest';
import { ChatResponseFormatter, ChatResponseFormatterImpl } from './chat-response-formatter';

describe('ChatResponseFormatter', () => {
  const formatter = new ChatResponseFormatterImpl();

  const AMP = String.fromCharCode(38);
  const LT = AMP + 'lt;';
  const GT = AMP + 'gt;';

  describe('format - citation patterns', () => {
    it('transforms a single <videoId:T:ss> citation to a clickable pill link', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'Test Video' } };
      const result = formatter.format('This is cited <dQw4w9WgXcQ:T:120> here.', signalMap);

      expect(result).toContain('<a href="/signals/dQw4w9WgXcQ#t-120000"');
      expect(result).toContain('rel="nofollow noreferrer"');
      expect(result).toContain('data-timestamp="120000"');
      expect(result).toContain('data-video-id="dQw4w9WgXcQ"');
      expect(result).toContain('Test Video');
      expect(result).toContain('[02:00]');
    });

    it('transforms multiple citations in one string', () => {
      const signalMap = { aaa111: { title: 'Video A' }, bbb222: { title: 'Video B' } };
      const result = formatter.format('<aaa111:T:10> and <bbb222:T:200>.', signalMap);

      expect(result).toContain('/signals/aaa111#t-10000');
      expect(result).toContain('Video A');
      expect(result).toContain('[00:10]');
      expect(result).toContain('/signals/bbb222#t-200000');
      expect(result).toContain('Video B');
      expect(result).toContain('[03:20]');
    });

    it('skips citations with missing videoId in signalMap', () => {
      const result = formatter.format('<unknown:T:50> is missing.', {});
      expect(result).not.toContain('<a href="/signals/unknown');
    });

    it('handles malformed citations like <videold:videoId: and strips them', () => {
      const signalMap = { QMn7cm4nfYU: { title: 'Crypto Video' } };
      const result = formatter.format('<videold:QMn7cm4nfYU: [10:42] something.', signalMap);

      expect(result).not.toContain('videold');
      expect(result).toContain('/signals/QMn7cm4nfYU#t-642000');
    });
  });

  describe('format - bare timestamp patterns', () => {
    it('converts bare T:ss timestamps with inherited videoId', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'Test Video' } };
      const result = formatter.format('<dQw4w9WgXcQ:T:120> and also [T:30] later.', signalMap);

      expect(result).toContain('/signals/dQw4w9WgXcQ#t-120000');
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-30000');
      expect(result).toContain('[00:30]');
    });

    it('inherits videoId across multiple bare timestamps', () => {
      const signalMap = { aaa: { title: 'A' }, bbb: { title: 'B' } };
      const result = formatter.format('<aaa:T:10> x [T:20] y <bbb:T:30> z [T:40].', signalMap);

      expect(result).toContain('/signals/aaa#t-20000');
      expect(result).toContain('/signals/bbb#t-40000');
    });

    it('handles [MM:SS] timestamps from LLM output', () => {
      const signalMap = { vid123: { title: 'Video One' } };
      const result = formatter.format('<vid123:T:780> discussed at [13:00] and [10:42].', signalMap);

      expect(result).toContain('/signals/vid123#t-780000');
      expect(result).toContain('/signals/vid123#t-642000');
    });

    it('uses fragment-only fallback for bare timestamps before any citation', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'Test Video' } };
      const result = formatter.format('[T:30] then <dQw4w9WgXcQ:T:120>.', signalMap);

      expect(result).toContain('href="#t-30000"');
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-120000');
    });
  });

  describe('format - single-signal (no citations, just timestamps)', () => {
    it('converts bare T:ss timestamps to clickable anchor links', () => {
      const signalMap = { vid1: { title: 'Video' } };
      const result = formatter.format('Something happened at T:45 and continued.', signalMap);

      expect(result).toContain('#t-45000');
      expect(result).toContain('[00:45]');
    });

    it('converts bracketed [T:ss] timestamps to clickable anchor links', () => {
      const signalMap = { vid1: { title: 'Video' } };
      const result = formatter.format('See [T:120] for the key moment.', signalMap);

      expect(result).toContain('#t-120000');
      expect(result).toContain('[02:00]');
    });

    it('handles multiple timestamps in one string', () => {
      const signalMap = { vid1: { title: 'Video' } };
      const result = formatter.format('First at T:10 then [T:200].', signalMap);

      expect(result).toContain('#t-10000');
      expect(result).toContain('[00:10]');
      expect(result).toContain('#t-200000');
      expect(result).toContain('[03:20]');
    });

    it('includes data-timestamp attribute on fragment links', () => {
      const signalMap = { vid1: { title: 'Video' } };
      const result = formatter.format('Check T:30.', signalMap);

      expect(result).toContain('data-timestamp="30000"');
    });
  });

  describe('format - GFM markdown (marked library)', () => {
    it('renders GFM tables as proper <table> HTML', () => {
      const signalMap = { vid1: { title: 'V' } };
      const input = [
        '| Column A | Column B |',
        '|----------|----------|',
        '| cell 1   | cell 2   |'
      ].join('\n');
      const result = formatter.format(input, signalMap);

      expect(result).toContain('<table>');
      expect(result).toContain('<tr>');
      expect(result).toContain('cell 1');
      expect(result).toContain('cell 2');
    });

    it('renders headings as proper <h> tags', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('## This is a heading', signalMap);

      expect(result).toContain('<h2>This is a heading</h2>');
    });

    it('renders bullet lists as <ul><li> tags', () => {
      const signalMap = { vid1: { title: 'V' } };
      const input = '- item one\n- item two\n- item three';
      const result = formatter.format(input, signalMap);

      expect(result).toContain('<ul>');
      expect(result).toContain('<li>item one</li>');
      expect(result).toContain('<li>item three</li>');
    });

    it('renders blockquotes', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('> this is a quote', signalMap);

      expect(result).toContain('<blockquote>');
      expect(result).toContain('this is a quote');
    });

    it('does NOT convert soft line breaks to <br> (breaks: false)', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('line one\nline two', signalMap);

      expect(result).not.toContain('<br>');
    });

    it('timestamps inside code spans still convert (known limitation)', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('See `T:42` for details.', signalMap);

      // Known limitation: timestamp regex runs before markdown processing, so T:42
      // inside backticks still gets converted to a pill link wrapped in <code>.
      // This is acceptable because LLM currently outputs bare T:ss text (not `T:ss`).
      expect(result).toContain('#t-42000');
      expect(result).toContain('<code>');
    });
  });

  describe('format - markdown and HTML escaping', () => {
    it('escapes HTML entities in text', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('He said <b>hello</b> & "wow" at T:5.', signalMap);

      expect(result).not.toContain('<b>');
      expect(result).toContain(LT + 'b' + GT);
    });

    it('converts **bold** Markdown to <strong> tags', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('This is **bold** text.', signalMap);

      expect(result).toContain('<strong>bold</strong>');
      expect(result).not.toContain('**');
    });

    it('converts *italic* Markdown to <em> tags', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('This is *italic* text.', signalMap);

      expect(result).toContain('<em>italic</em>');
      expect(result).not.toContain('*italic*');
    });

    it('handles bold and italic together with timestamps', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('**Key point** at T:45 is *important*.', signalMap);

      expect(result).toContain('<strong>Key point</strong>');
      expect(result).toContain('<em>important</em>');
      expect(result).toContain('#t-45000');
    });

    it('escapes raw HTML but preserves Markdown', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('<script>alert(1)</script> **safe** text.', signalMap);

      expect(result).not.toContain('<script>');
      expect(result).toContain(LT + 'script' + GT);
      expect(result).toContain('<strong>safe</strong>');
    });

    it('handles __bold__ underscore syntax', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('This is __bold__ text.', signalMap);

      expect(result).toContain('<strong>bold</strong>');
    });

    it('handles _italic_ underscore syntax', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('This is _italic_ text.', signalMap);

      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('format - plain text passthrough', () => {
    it('returns text unchanged when no citations or timestamps present', () => {
      const signalMap = { aaa111: { title: 'V' } };
      const result = formatter.format('No citations here.', signalMap);
      expect(result).toBe('No citations here.');
    });

    it('handles empty string', () => {
      const result = formatter.format('', {});
      expect(result).toBe('');
    });
  });

  describe('format - leaves malformed delimiters escaped', () => {
    it('leaves malformed delimiters as escaped text', () => {
      const result = formatter.format('Bad <notacitation> and <also:bad>.', {});
      expect(result).toContain(LT + 'notacitation' + GT);
    });
  });

  describe('format - title-based videoId context (issue #154)', () => {
    it('tracer bullet: timestamps under **Source Title** heading get deep links via title matching', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'Rick Astley - Never Gonna Give You Up' } };
      const result = formatter.format(
        '**Rick Astley - Never Gonna Give You Up**\n\nThe artist explains at [3:27].',
        signalMap
      );

      // Timestamp should produce deep link, not fragment-only
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-207000');
      expect(result).not.toContain('href="#t-207000"');
    });

    it('multiple headings with different videoIds each control their own timestamps', () => {
      const signalMap = {
        vidAAA: { title: 'Video Alpha' },
        vidBBB: { title: 'Video Beta' }
      };
      const result = formatter.format(
        '**Video Alpha**\n\nPoint A at [1:00].\n\n**Video Beta**\n\nPoint B at [2:30].',
        signalMap
      );

      // First timestamp belongs to Video Alpha
      expect(result).toContain('/signals/vidAAA#t-60000');
      // Second timestamp belongs to Video Beta
      expect(result).toContain('/signals/vidBBB#t-150000');
    });

    it('partial title match still resolves videoId', () => {
      const signalMap = { vid123: { title: 'MTG News Weekly Episode 42' } };
      const result = formatter.format(
        '**MTG News Weekly**\n\nDiscussion at [5:00].',
        signalMap
      );

      expect(result).toContain('/signals/vid123#t-300000');
    });

    it('timestamps before any heading fall back to fragment-only link', () => {
      const signalMap = { vid1: { title: 'Some Video' } };
      const result = formatter.format(
        'Intro point at [0:30].\n\n**Some Video**\n\nMain point at [1:00].',
        signalMap
      );

      // First timestamp has no heading context → fragment-only
      expect(result).toContain('href="#t-30000"');
      // Second timestamp is under heading → deep link
      expect(result).toContain('/signals/vid1#t-60000');
    });

    it('citation-based videoId inheritance still works (single-signal regression)', () => {
      const signalMap = { vid1: { title: 'V' } };
      const result = formatter.format('<vid1:T:10> and [T:20].', signalMap);

      expect(result).toContain('/signals/vid1#t-10000');
      expect(result).toContain('/signals/vid1#t-20000');
    });
  });

  describe('singleton', () => {
    it('uses ChatResponseFormatter singleton', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'V' } };
      const result = ChatResponseFormatter.format('<dQw4w9WgXcQ:T:5>', signalMap);
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-5000');
    });
  });
});

// =============================================================================
// Regression: issue-153 — citation pills inside markdown table cells
// =============================================================================

describe('Regression: issue-153 — citation pills inside markdown table cells', () => {
  const formatter = new ChatResponseFormatterImpl();

  it('T:ss timestamps inside GFM table cells produce valid <table> HTML with working pill links inside <td> cells', () => {
    const signalMap = { vid_abc123: { title: 'Source Video' } };
    const input = [
      '| Timestamp | Finding |',
      '|-----------|---------|',
      '| <vid_abc123:T:142> S&P 500 correction expected |',
      '| T:734 Broad index funds strategy |'
    ].join('\n');

    const result = formatter.format(input, signalMap);

    expect(result).toContain('<table>');
    expect(result).toContain('</table>');
    expect(result).toContain('href="/signals/vid_abc123#t-142000"');
    expect(result).toContain('[02:22]');
    expect(result).toContain('href="/signals/vid_abc123#t-734000"');
    expect(result).toContain('[12:14]');
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

    expect(result).toContain('href="/signals/v1#t-30000"');
    expect(result).toContain('href="/signals/v1#t-90000"');
    expect(result).toContain('href="/signals/v2#t-200000"');
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
    expect(result).toContain('href="#t-10000"');
    expect(result).toContain('cyclusvergelijking');
  });
});

// =============================================================================
// Regression: issue-153 — timestamp accuracy regression
// =============================================================================

describe('Regression: issue-153 — timestamp accuracy regression', () => {
  const formatter = new ChatResponseFormatterImpl();

  it('[T:ss] converts to correct MM:SS display and exact ms deep link', () => {
    const signalMap = { vid_abc: { title: 'Test Video' } };
    const result = formatter.format(
      '**Test Video**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:1921]  | Space solar power shifts to infrared beaming |',
      signalMap
    );

    expect(result).toContain('[32:01]');
    expect(result).toContain('href="/signals/vid_abc#t-1921000"');
    expect(result).not.toContain('[31:61]');
  });

  it('large T:ss values convert correctly without LLM arithmetic errors', () => {
    const signalMap = { vid_x: { title: 'V' } };
    const result = formatter.format(
      '**V**\n\n| Timestamp | Finding |\n|-----------|---------|\n| [T:1602]  | Universal constants simulated parameters |',
      signalMap
    );

    expect(result).toContain('[26:42]');
    expect(result).toContain('href="/signals/vid_x#t-1602000"');
  });
});
