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

  describe('singleton', () => {
    it('uses ChatResponseFormatter singleton', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'V' } };
      const result = ChatResponseFormatter.format('<dQw4w9WgXcQ:T:5>', signalMap);
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-5000');
    });
  });
});