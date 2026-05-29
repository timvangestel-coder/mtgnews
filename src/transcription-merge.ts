/**
 * Transcription Merge Module — pure-function module for segment merging and grouping.
 *
 * No I/O, no format detection — purely algorithmic. Input/output types are plain interfaces.
 */

export interface RawSegment {
  text: string;
  start: number;
  end: number;
}

export interface MergedSegment {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionGroup {
  time: number;
  text: string;
}

/**
 * Merge overlapping "paint-on" VTT segments produced by YouTube auto-captions.
 *
 * YouTube's auto-generated VTT uses a sliding-window rendering style where each
 * segment starts slightly before the previous one ends and contains accumulated
 * text. This function collapses such overlapping groups into single segments
 * by keeping the most complete text and the earliest start timestamp.
 *
 * Then it trims overlapping words at boundaries between consecutive segments
 * (e.g., if segment 1 ends with "welcome" and segment 2 starts with "welcome",
 * the duplicate is removed from segment 2).
 */
export function mergeOverlappingSegments(segments: RawSegment[]): MergedSegment[] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return [segments[0]];

  // Phase 1: merge paint-on superset segments
  const merged: MergedSegment[] = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const current = segments[i];
    const prev = merged[merged.length - 1];

    // Check if current segment overlaps or is contiguous with previous
    // AND current text starts with previous text (superset/paint-on pattern)
    // YouTube paint-on segments can be contiguous (end == next start) not just overlapping
    const hasTimestampOverlap = current.start <= prev.end;
    const isTextSuperset = current.text.toLowerCase().startsWith(prev.text.toLowerCase().trim());

    if (hasTimestampOverlap && isTextSuperset) {
      // Merge: keep earliest start, use current's text (superset), extend end
      prev.start = Math.min(prev.start, current.start);
      prev.text = current.text;
      prev.end = Math.max(prev.end, current.end);
    } else {
      // No merge: push as new segment
      merged.push({ ...current });
    }
  }

  // Phase 2: trim overlapping words at segment boundaries
  // YouTube auto-captions often have the last word(s) of one segment repeated
  // at the start of the next segment (e.g., "...welcome" then "welcome back...")
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const curr = merged[i];
    const trimmed = trimLeadingWordOverlap(prev.text, curr.text);
    if (trimmed !== curr.text) {
      curr.text = trimmed;
    }
  }

  // Remove any segments that became empty after trimming
  return merged.filter(seg => seg.text.trim().length > 0);
}

/**
 * Remove leading words from `current` that overlap with trailing words of `previous`.
 *
 * Example: previous = "Folks, welcome", current = "welcome back."
 * Returns: "back."
 */
function trimLeadingWordOverlap(previous: string, current: string): string {
  const prevWords = previous.toLowerCase().split(/\s+/).filter(Boolean);
  const currWords = current.split(/\s+/).filter(Boolean);
  const currWordsLower = currWords.map((w) => w.toLowerCase());

  if (prevWords.length === 0 || currWords.length === 0) return current;

  // Find the longest suffix of `previous` that matches a prefix of `current`.
  // Try from the largest possible overlap down to 1 — first match wins.
  let overlapCount = 0;
  const maxOverlap = Math.min(prevWords.length, currWords.length);

  for (let n = maxOverlap; n >= 1; n--) {
    // Get last n words of previous
    const prevTail = prevWords.slice(-n);
    // Get first n words of current
    const currHead = currWordsLower.slice(0, n);

    let matches = true;
    for (let j = 0; j < n; j++) {
      if (prevTail[j] !== currHead[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlapCount = n;
      break;
    }
  }

  if (overlapCount === 0) return current;

  // Remove the overlapping words from the start of current, preserving original casing
  const remaining = currWords.slice(overlapCount);
  return remaining.join(' ');
}

/**
 * Group transcription segments into ~10-second windows.
 * Transforms raw segments into grouped `{time, text}` where `time` is milliseconds
 * rounded to the nearest second. Pure function, no side effects.
 */
export function groupSegments(segments: MergedSegment[]): TranscriptionGroup[] {
  if (segments.length === 0) return [];

  const groups: Array<{ time: number; texts: string[] }> = [];
  let current: { time: number; texts: string[] } | null = null;
  const INTERVAL_MS = 10_000;

  for (const seg of segments) {
    if (!current || seg.start - current.time >= INTERVAL_MS) {
      current = { time: Math.round(seg.start / 1000) * 1000, texts: [seg.text] };
      groups.push(current);
    } else {
      current.texts.push(seg.text);
    }
  }

  return groups.map((g) => ({ time: g.time, text: g.texts.join(' ') }));
}