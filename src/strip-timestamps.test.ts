import { describe, it, expect } from 'vitest';
import { stripTimestamps } from './strip-timestamps';

describe('stripTimestamps', () => {
  it('removes [T:\\d+] patterns', () => {
    expect(stripTimestamps('Hello [T:45] world')).toBe('Hello world');
  });

  it('removes [MM:SS] patterns', () => {
    expect(stripTimestamps('Text [01:23] here')).toBe('Text here');
    expect(stripTimestamps('Text [1:23] here')).toBe('Text here');
    expect(stripTimestamps('[00:05] Intro')).toBe('Intro');
  });

  it('removes <<...>> patterns', () => {
    expect(stripTimestamps('Hello <<timestamp>> world')).toBe('Hello world');
    expect(stripTimestamps('<<music>> playing')).toBe('playing');
  });

  it('removes multiple timestamp patterns', () => {
    const input = '[T:10] Hello world [01:30] this is a <<beep>> test [T:99]';
    expect(stripTimestamps(input)).toBe('Hello world this is a test');
  });

  it('returns empty string for only-timestamp input', () => {
    expect(stripTimestamps('[T:0]')).toBe('');
  });

  it('handles text with no timestamps', () => {
    expect(stripTimestamps('Hello world')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(stripTimestamps('')).toBe('');
  });

  it('collapses multiple spaces', () => {
    expect(stripTimestamps('Hello   [T:1]    world')).toBe('Hello world');
  });

  // BUG: real summaries contain bare T:NNN patterns without brackets
  // e.g. "T:223 Community-driven governance already shifts AI adoption"
  it('strips bare T:\\d+ patterns (without brackets)', () => {
    const sample = 'Delivered at a Berlin technology forum. T:223 Community-driven governance. T:271 Treating data.';
    const result = stripTimestamps(sample);
    expect(result).not.toContain('T:223');
    expect(result).not.toContain('T:271');
    expect(result).toBe('Delivered at a Berlin technology forum. Community-driven governance. Treating data.');
  });

  it('strips bare T:\\d+ at start of string', () => {
    expect(stripTimestamps('T:45 Hello world')).toBe('Hello world');
  });

  it('strips bare T:\\d+ with multi-digit numbers', () => {
    expect(stripTimestamps('T:12345 long timestamp')).toBe('long timestamp');
  });
});
