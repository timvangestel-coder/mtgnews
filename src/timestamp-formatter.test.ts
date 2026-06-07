import { describe, it, expect } from 'vitest';
import { TimestampFormatter, TimestampFormatterImpl } from './timestamp-formatter';

describe('TimestampFormatter', () => {
  const formatter = new TimestampFormatterImpl();

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const AMP = String.fromCharCode(38); // &
  const LT = AMP + 'lt;';
  const GT = AMP + 'gt;';
  const AMP_ENT = AMP + 'amp;';
  const QUOT = AMP + 'quot;';
  /* eslint-enable */

  describe('format', () => {
    it('converts bare T:ss timestamps to clickable anchor links', () => {
      const result = formatter.format('Something happened at T:45 and continued.');
      expect(result).toContain('<a href="#t-45000"');
      expect(result).toContain('[00:45]');
    });

    it('converts bracketed [T:ss] timestamps to clickable anchor links', () => {
      const result = formatter.format('See [T:120] for the key moment.');
      expect(result).toContain('<a href="#t-120000"');
      expect(result).toContain('[02:00]');
    });

    it('handles multiple timestamps in one string', () => {
      const result = formatter.format('First at T:10 then [T:200].');
      expect(result).toContain('#t-10000');
      expect(result).toContain('[00:10]');
      expect(result).toContain('#t-200000');
      expect(result).toContain('[03:20]');
    });

    it('escapes HTML entities in text', () => {
      const result = formatter.format('He said <b>hello</b> & "wow" at T:5.');
      // Should NOT contain raw <b> tag (it should be escaped)
      expect(result).not.toContain('<b>');
      expect(result).toContain(LT + 'b' + GT);
      expect(result).toContain(AMP_ENT);
    });

    it('returns text unchanged when no timestamps present', () => {
      const result = formatter.format('No timestamps here, just plain text.');
      expect(result).toBe('No timestamps here, just plain text.');
    });

    it('handles empty string', () => {
      const result = formatter.format('');
      expect(result).toBe('');
    });

    it('includes rel and data-timestamp attributes on links', () => {
      const result = formatter.format('Check T:30.');
      expect(result).toContain('rel="nofollow noreferrer"');
      expect(result).toContain('data-timestamp="30000"');
    });

    it('formats minutes correctly for timestamps over 60 seconds', () => {
      const result = formatter.format('At T:90 something happened.');
      expect(result).toContain('[01:30]');
    });

    it('converts **bold** Markdown to <strong> tags', () => {
      const result = formatter.format('This is **bold** text.');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).not.toContain('**');
    });

    it('converts *italic* Markdown to <em> tags', () => {
      const result = formatter.format('This is *italic* text.');
      expect(result).toContain('<em>italic</em>');
      expect(result).not.toContain('*italic*');
    });

    it('handles bold and italic together with timestamps', () => {
      const result = formatter.format('**Key point** at T:45 is *important*.');
      expect(result).toContain('<strong>Key point</strong>');
      expect(result).toContain('<em>important</em>');
      expect(result).toContain('#t-45000');
    });

    it('escapes raw HTML but preserves Markdown', () => {
      const result = formatter.format('<script>alert(1)</script> **safe** text.');
      expect(result).not.toContain('<script>');
      expect(result).toContain(LT + 'script' + GT);
      expect(result).toContain('<strong>safe</strong>');
    });

    it('handles __bold__ underscore syntax', () => {
      const result = formatter.format('This is __bold__ text.');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('handles _italic_ underscore syntax', () => {
      const result = formatter.format('This is _italic_ text.');
      expect(result).toContain('<em>italic</em>');
    });
  });
});