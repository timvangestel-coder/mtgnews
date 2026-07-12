/**
 * stripTimestamps — pure function to remove timestamp markers from text.
 *
 * Removes:
 *  - [T:\d+]  (e.g. [T:45])
 *  - [MM:SS]  (e.g. [01:23])
 *  - <<...>>  (e.g. <<timestamp>>)
 *
 * No I/O, no side effects — fully unit-testable in isolation.
 */

const TIMESTAMP_PATTERNS = [
  /\[T:\d+\]/g,       // [T:45] (bracketed)
  /\[\d{1,2}:\d{2}\]/g, // [01:23] or [1:23]
  /<<[^>]+>>/g,       // <<anything>>
  /\bT:\d+\b/g,       // T:223 (bare, no brackets — used as reference markers in LLM summaries)
];

export function stripTimestamps(text: string): string {
  let result = text;
  for (const pattern of TIMESTAMP_PATTERNS) {
    result = result.replace(pattern, '');
  }
  // Collapse multiple spaces into one
  result = result.replace(/ {2,}/g, ' ');
  return result.trim();
}
