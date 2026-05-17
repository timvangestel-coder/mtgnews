import { describe, expect, it } from 'vitest';
import { mergeOverlappingSegments } from './transcription';
import type { TranscriptionSegment } from './transcription';

describe('mergeOverlappingSegments', () => {
  // Tracer bullet: basic overlapping paint-on segments merge into one
  it('merges overlapping segments where each is a superset of the previous', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'Folks,', start: 4150, end: 5000 },
      { text: 'Folks, welcome', start: 4160, end: 6000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Folks, welcome');
    expect(result[0].start).toBe(4150);
    expect(result[0].end).toBe(6000);
  });

  // Real-world pattern from actual DB: contiguous segments with boundary word overlap
  it('merges contiguous segments and trims overlapping boundary words', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'Folks,', start: 4150, end: 4160 },
      { text: 'Folks, welcome', start: 4160, end: 5670 },
      { text: 'welcome back. My name is Rudy. You\'re', start: 5670, end: 5680 },
      { text: 'welcome back. My name is Rudy. You\'re watching', start: 5680, end: 8150 },
      { text: 'watching Alpha Investments, the world', start: 8150, end: 8160 },
      { text: 'watching Alpha Investments, the world famous', start: 8160, end: 11430 },
      { text: 'famous Florida man channel. One guy\'s journey', start: 11430, end: 13990 },
      { text: 'journey to bet his life on cardboard in a', start: 13990, end: 16230 },
      { text: 'a world that ridiculed for the first 10,', start: 16230, end: 18000 },
    ];

    const result = mergeOverlappingSegments(segments);

    // Phase 1: 9 segments merge into 6 (pairs 1+2, 3+4, 5+6 merge; 7,8,9 stay separate)
    // Phase 2: trim boundary words: "welcome", "watching", "famous", "journey", "a"
    expect(result).toHaveLength(6);
    expect(result[0].text).toBe('Folks, welcome');
    expect(result[0].start).toBe(4150);
    expect(result[1].text).toBe('back. My name is Rudy. You\'re watching');
    expect(result[1].start).toBe(5670);
    expect(result[2].text).toBe('Alpha Investments, the world famous');
    expect(result[2].start).toBe(8150);
    expect(result[3].text).toBe('Florida man channel. One guy\'s journey');
    expect(result[3].start).toBe(11430);
    expect(result[4].text).toBe('to bet his life on cardboard in a');
    expect(result[4].start).toBe(13990);
    expect(result[5].text).toBe('world that ridiculed for the first 10,');
    expect(result[5].start).toBe(16230);
  });

  // Real-world pattern: paint-on sequence from YouTube auto-captions (overlapping variant)
  it('collapses a full paint-on sequence into merged segments', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'Folks,', start: 4150, end: 5000 },
      { text: 'Folks, welcome', start: 4160, end: 5660 },
      { text: 'welcome back. My name is Rudy. You\'re', start: 5670, end: 8140 },
      { text: 'welcome back. My name is Rudy. You\'re watching', start: 5680, end: 8160 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Folks, welcome');
    expect(result[0].start).toBe(4150);
    // "welcome" trimmed from start of segment 2 since it overlaps with end of segment 1
    expect(result[1].text).toBe('back. My name is Rudy. You\'re watching');
    expect(result[1].start).toBe(5670);
  });

  // No overlap: segments that don't overlap stay separate
  it('leaves non-overlapping segments unchanged', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'hello world', start: 0, end: 2500 },
      { text: 'mtg news today', start: 2500, end: 5000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(segments[0]);
    expect(result[1]).toEqual(segments[1]);
  });

  // Edge case: empty input
  it('returns empty array for empty input', () => {
    expect(mergeOverlappingSegments([])).toHaveLength(0);
  });

  // Edge case: single segment
  it('returns single segment unchanged', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'only segment', start: 0, end: 3000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(segments[0]);
  });

  // No text overlap: overlapping timestamps but different content
  it('keeps segments separate when timestamps overlap but text does not', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'first sentence', start: 0, end: 3000 },
      { text: 'completely different', start: 2000, end: 5000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
  });

  // Multi-word prefix match: current text starts with previous text
  it('merges when current text is a strict extension of previous text', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'welcome back', start: 1000, end: 4000 },
      { text: 'welcome back to the show', start: 1500, end: 5000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('welcome back to the show');
    expect(result[0].start).toBe(1000);
    expect(result[0].end).toBe(5000);
  });

  // Case insensitive text comparison
  it('handles case-insensitive prefix matching', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'Hello', start: 0, end: 2000 },
      { text: 'Hello world', start: 500, end: 3000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
  });

  // Longer chain: multiple overlapping groups
  it('merges multiple independent overlapping groups', () => {
    const segments: TranscriptionSegment[] = [
      // Group 1: paint-on overlap
      { text: 'alpha', start: 0, end: 1000 },
      { text: 'alpha beta', start: 100, end: 2000 },
      // Gap
      // Group 2: paint-on overlap
      { text: 'gamma', start: 5000, end: 6000 },
      { text: 'gamma delta', start: 5100, end: 7000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('alpha beta');
    expect(result[0].start).toBe(0);
    expect(result[1].text).toBe('gamma delta');
    expect(result[1].start).toBe(5000);
  });

  // Boundary word trim: multi-word overlap
  it('trims multi-word boundary overlap', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'hello world foo bar', start: 0, end: 3000 },
      { text: 'foo bar baz', start: 3000, end: 6000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('hello world foo bar');
    // "foo bar" trimmed from start since it overlaps with end of segment 1
    expect(result[1].text).toBe('baz');
  });

  // Boundary word trim: no overlap case
  it('does not trim when there is no word overlap at boundary', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'hello world', start: 0, end: 3000 },
      { text: 'foo bar', start: 3000, end: 6000 },
    ];

    const result = mergeOverlappingSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('hello world');
    expect(result[1].text).toBe('foo bar');
  });

  // Boundary word trim: punctuation handling - word with comma
  it('trims boundary overlap ignoring trailing punctuation', () => {
    const segments: TranscriptionSegment[] = [
      { text: 'welcome to the show', start: 0, end: 3000 },
      { text: 'show you need to see', start: 3000, end: 6000 },
    ];

    const result = mergeOverlappingSegments(segments);

    // "show" overlaps at boundary - trimmed from segment 2
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('welcome to the show');
    expect(result[1].text).toBe('you need to see');
  });
});