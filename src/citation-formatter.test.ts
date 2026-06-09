import { describe, it, expect } from 'vitest';
import { CitationFormatter, CitationFormatterImpl } from './citation-formatter';

describe('CitationFormatter', () => {
  const formatter = new CitationFormatterImpl();

  const AMP = String.fromCharCode(38); // &
  const LT = AMP + 'lt;';
  const GT = AMP + 'gt;';

  describe('format', () => {
    it('transforms a single <videoId:T:ss> citation to a clickable pill link', () => {
      const signalMap = {
        dQw4w9WgXcQ: { title: 'Test Video' },
      };
      const result = formatter.format('This is cited <dQw4w9WgXcQ:T:120> here.', signalMap);

      expect(result).toContain('<a href="/signals/dQw4w9WgXcQ#t-120000"');
      expect(result).toContain('rel="nofollow noreferrer"');
      expect(result).toContain('Test Video');
      expect(result).toContain('[02:00]');
    });

    it('transforms multiple citations in one string', () => {
      const signalMap = {
        aaa111: { title: 'Video A' },
        bbb222: { title: 'Video B' },
      };
      const result = formatter.format('<aaa111:T:10> and <bbb222:T:200>.', signalMap);

      expect(result).toContain('/signals/aaa111#t-10000');
      expect(result).toContain('Video A');
      expect(result).toContain('[00:10]');
      expect(result).toContain('/signals/bbb222#t-200000');
      expect(result).toContain('Video B');
      expect(result).toContain('[03:20]');
    });

    it('returns text unchanged when no citations present', () => {
      const signalMap = { aaa111: { title: 'V' } };
      const result = formatter.format('No citations here.', signalMap);
      expect(result).toBe('No citations here.');
    });

    it('leaves malformed delimiters as escaped text', () => {
      const signalMap = {};
      const result = formatter.format('Bad <notacitation> and <also:bad>.', signalMap);
      // The angle brackets should be HTML-escaped since they are not valid citations
      expect(result).toContain(LT + 'notacitation' + GT);
    });

    it('skips citations with missing videoId in signalMap', () => {
      const signalMap = {};
      const result = formatter.format('<unknown:T:50> is missing.', signalMap);
      // Should not produce an <a> tag for the unknown videoId
      expect(result).not.toContain('<a href="/signals/unknown');
    });

    it('converts remaining [T:ss] timestamps via TimestampFormatter delegation', () => {
      const signalMap = {
        dQw4w9WgXcQ: { title: 'Test Video' },
      };
      const result = formatter.format('<dQw4w9WgXcQ:T:120> and also [T:30] later.', signalMap);

      // Citation pill
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-120000');
      // Delegated timestamp pill — now gets absolute link from last-cited videoId (not fragment-only)
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-30000');
      expect(result).toContain('[00:30]');
    });

    it('uses fragment-only link for bare timestamps before any citation', () => {
      const signalMap = {
        dQw4w9WgXcQ: { title: 'Test Video' },
      };
      const result = formatter.format('[T:30] then <dQw4w9WgXcQ:T:120>.', signalMap);

      // Bare timestamp before any citation has no video context → fragment-only fallback
      expect(result).toContain('href="#t-30000"');
      // Citation gets absolute link
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-120000');
    });

    it('inherits videoId across multiple bare timestamps', () => {
      const signalMap = {
        aaa: { title: 'A' },
        bbb: { title: 'B' },
      };
      const result = formatter.format('<aaa:T:10> x [T:20] y <bbb:T:30> z [T:40].', signalMap);

      // First bare timestamp inherits aaa
      expect(result).toContain('/signals/aaa#t-20000');
      // Second bare timestamp inherits bbb (most recent citation)
      expect(result).toContain('/signals/bbb#t-40000');
    });

    it('handles [MM:SS] timestamps from LLM output', () => {
      const signalMap = {
        vid123: { title: 'Video One' },
      };
      const result = formatter.format('<vid123:T:780> discussed at [13:00] and [10:42].', signalMap);

      // Citation pill
      expect(result).toContain('/signals/vid123#t-780000');
      // [13:00] = 780 seconds, inherits vid123
      expect(result).toContain('/signals/vid123#t-780000');
      // [10:42] = 642 seconds, inherits vid123
      expect(result).toContain('/signals/vid123#t-642000');
    });

    it('handles [MM:SS] before any citation with fragment fallback', () => {
      const signalMap = {
        vid123: { title: 'V' },
      };
      const result = formatter.format('[05:30] then <vid123:T:10>.', signalMap);

      // [05:30] before citation has no video context → fragment-only
      expect(result).toContain('href="#t-330000"');
      // Citation gets absolute link
      expect(result).toContain('/signals/vid123#t-10000');
    });

    it('handles malformed citations like <videold:videoId: and strips them', () => {
      const signalMap = {
        QMn7cm4nfYU: { title: 'Crypto Video' },
      };
      const result = formatter.format('<videold:QMn7cm4nfYU: [10:42] something.', signalMap);

      // Malformed citation establishes video context but is stripped from output
      expect(result).not.toContain('videold');
      // [10:42] inherits the videoId → absolute link
      expect(result).toContain('/signals/QMn7cm4nfYU#t-642000');
    });

    it('handles malformed citation followed by multiple timestamps', () => {
      const signalMap = {
        QMn7cm4nfYU: { title: 'V1' },
        abc123def456: { title: 'V2' },
      };
      const result = formatter.format('<videold:QMn7cm4nfYU: [10:42] and <videold:abc123def456: [11:23].', signalMap);

      // First timestamp inherits QMn7cm4nfYU
      expect(result).toContain('/signals/QMn7cm4nfYU#t-642000');
      // Second timestamp inherits abc123def456
      expect(result).toContain('/signals/abc123def456#t-683000');
    });

    it('handles empty string', () => {
      const result = formatter.format('', {});
      expect(result).toBe('');
    });

    it('uses CitationFormatter singleton', () => {
      const signalMap = { dQw4w9WgXcQ: { title: 'V' } };
      const result = CitationFormatter.format('<dQw4w9WgXcQ:T:5>', signalMap);
      expect(result).toContain('/signals/dQw4w9WgXcQ#t-5000');
    });
  });
});