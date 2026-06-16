/**
 * Deep module that unifies CitationFormatter + TimestampFormatter into a single
 * formatter for transforming raw LLM text into rendered HTML for chat answers.
 *
 * Produces uniform timestamp links regardless of scope type (single-signal or multi-signal).
 * All citation pills include data-timestamp and data-video-id attributes.
 *
 * Pure function: no DB access, no side effects.
 *
 * Markdown rendering uses the `marked` library with GFM enabled for full support
 * of tables, lists, headings, blockquotes, etc.
 */

import { marked } from 'marked';

const PILL_CLASSES = 'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors';

interface SignalInfo {
  title: string;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Find best matching videoId for a heading title.
 * Tries exact match first, then falls back to substring/partial match.
 */
function findBestTitleMatch(headingLower: string, titleToVideoId: Map<string, string>): string | undefined {
  // Exact match first
  if (titleToVideoId.has(headingLower)) {
    return titleToVideoId.get(headingLower);
  }

  // Partial match: find a signal title that contains the heading text or is contained by it
  // Prefer longest match to avoid false positives from short substrings
  let bestMatch: string | undefined;
  let bestScore = 0;

  for (const [signalTitleLower, videoId] of titleToVideoId.entries()) {
    // Check if heading is a substring of signal title OR signal title is substring of heading
    const containsHeading = signalTitleLower.includes(headingLower);
    const containedInHeading = headingLower.includes(signalTitleLower);

    if (containsHeading || containedInHeading) {
      // Score by the length of the overlapping portion — longer overlap = better match
      const score = Math.min(signalTitleLower.length, headingLower.length);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = videoId;
      }
    }
  }

  return bestMatch;
}

/**
 * Process plain text for markdown rendering.
 *
 * Strategy: escape `<` to prevent raw HTML injection, but protect `>` at line
 * starts so blockquotes still work. Then run marked which handles all markdown
 * natively (bold, italic, tables, lists, headings, blockquotes).
 */
function processText(text: string): string {
  // Protect blockquote markers (> at start of lines) with placeholder
  text = text.replace(/^(\s*>)/gm, '\x00BQ\x00');

  // Escape < to prevent raw HTML passthrough
  const amp = String.fromCharCode(38);
  const map: Record<string, string> = {
    '&': amp + 'amp;',
    '<': amp + 'lt;',
    '>': amp + 'gt;',
    '"': amp + 'quot;',
    "'": amp + '#39;',
  };
  text = text.replace(/[&<>"']/g, (m) => map[m]);

  // Restore blockquote markers — use function to return captured group
  text = text.replace(/\x00BQ\x00/g, () => '>');

  // Render Markdown with marked (GFM mode, breaks: false)
  const rendered = marked.parse(text, { gfm: true, breaks: false }) as string;

  // Remove leading/trailing <p> wrapper and trailing newline that marked adds
  return rendered.replace(/^<p>/, '').replace(/<\/p>\n?$/, '');
}

export interface ChatResponseFormatter {
  /**
   * Transform raw LLM text into rendered HTML with timestamp citation pills.
   * @param text - raw LLM response text
   * @param signalMap - map of videoId to signal info (always required)
   */
  format(text: string, signalMap: Record<string, SignalInfo>): string;
}

export class ChatResponseFormatterImpl implements ChatResponseFormatter {
  format(text: string, signalMap: Record<string, SignalInfo>): string {
    // Collect ALL matches with positions.
    type Match = { pos: number; len: number; videoId?: string; seconds?: string };
    const allMatches: Match[] = [];

    // Phase 0: Build reverse index title → videoId for heading-based context resolution
    const titleToVideoId = new Map<string, string>();
    for (const [videoId, info] of Object.entries(signalMap)) {
      titleToVideoId.set(info.title.toLowerCase(), videoId);
    }

    // Pattern 0: **Title** headings that set active videoId context
    type HeadingMatch = { pos: number; len: number; title: string };
    const headingMatches: HeadingMatch[] = [];
    text.replace(/\*\*(.+?)\*\*/g, (_match, title, pos) => {
      // Only treat as heading if the title matches (or partially matches) a signal in signalMap
      const lowerTitle = title.toLowerCase();
      const matchedVideoId = findBestTitleMatch(lowerTitle, titleToVideoId);
      if (matchedVideoId) {
        headingMatches.push({ pos, len: _match.length, title });
      }
      return _match;
    });

    // Pattern 1: <videoId:T:ss> — proper citation format
    text.replace(/<([A-Za-z0-9_-]+):T:(\d+)>/g, (_match, videoId, seconds, pos) => {
      allMatches.push({ pos, len: _match.length, videoId, seconds });
      return _match;
    });

    // Pattern 1b: Malformed citations — <xxx:videoId: where xxx is not "T" and videoId matches signalMap
    text.replace(/<([A-Za-z0-9_-]+):([A-Za-z0-9_-]{5,}):/g, (_match, prefix, candidateVideoId, pos) => {
      if (prefix !== 'T' && signalMap[candidateVideoId]) {
        allMatches.push({ pos, len: _match.length, videoId: candidateVideoId });
      }
      return _match;
    });

    // Pattern 2: [MM:SS] — minute:second timestamps
    text.replace(/\[(\d{1,3}):(\d{2})\]/g, (_match, minsStr, secsStr, pos) => {
      const mins = parseInt(minsStr, 10);
      const secs = parseInt(secsStr, 10);
      if (secs >= 0 && secs <= 59) {
        const dominated = allMatches.some(m => pos >= m.pos && pos < m.pos + m.len);
        if (!dominated) {
          const totalSeconds = mins * 60 + secs;
          allMatches.push({ pos, len: _match.length, seconds: String(totalSeconds) });
        }
      }
      return _match;
    });

    // Pattern 3: T:ss or [T:ss] — bare timestamps in seconds
    text.replace(/(?:\[)?(T:(\d+))(?:\])?/g, (_match, ref, seconds, pos) => {
      const dominated = allMatches.some(m => pos >= m.pos && pos < m.pos + m.len);
      if (!dominated) {
        allMatches.push({ pos, len: _match.length, seconds });
      }
      return _match;
    });

    // Sort left-to-right to determine inherited videoId for each bare timestamp
    const sorted = [...allMatches].sort((a, b) => a.pos - b.pos);

    // Annotate each match with the effective videoId using both citations AND heading context
    let lastVideoId: string | undefined;
    let headingIndex = 0;
    const annotated = sorted.map(m => {
      // Advance heading pointer to find headings that appear before this match
      while (headingIndex < headingMatches.length && headingMatches[headingIndex].pos < m.pos) {
        const h = headingMatches[headingIndex];
        const matchedVideoId = findBestTitleMatch(h.title.toLowerCase(), titleToVideoId);
        if (matchedVideoId) {
          lastVideoId = matchedVideoId;
        }
        headingIndex++;
      }

      // Citations override heading context
      if (m.videoId && signalMap[m.videoId]) {
        lastVideoId = m.videoId;
      }
      return { ...m, effectiveVideoId: lastVideoId };
    });

    // Sort right-to-left for safe position-based replacement
    annotated.sort((a, b) => b.pos - a.pos);

    // Replace each match right-to-left so positions stay valid
    let result = text;
    for (let i = 0; i < annotated.length; i++) {
      const m = annotated[i] as Match & { effectiveVideoId?: string };
      const before = result.substring(0, m.pos);
      const after = result.substring(m.pos + m.len);

      if (m.videoId && signalMap[m.videoId]) {
        if (m.seconds) {
          // Citation with timestamp — produce pill with data attributes
          const ms = parseInt(m.seconds, 10) * 1000;
          const label = formatTime(ms);
          const pill = `<a href="/signals/${m.videoId}#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}" data-video-id="${m.videoId}">${signalMap[m.videoId].title} &middot; [${label}]</a>`;
          result = before + pill + after;
        } else {
          // Malformed citation without timestamp — just remove the raw text
          result = before + after;
        }
      } else if (m.effectiveVideoId && signalMap[m.effectiveVideoId] && m.seconds) {
        // Bare timestamp with inherited videoId — absolute link
        const ms = parseInt(m.seconds, 10) * 1000;
        const label = formatTime(ms);
        const pill = `<a href="/signals/${m.effectiveVideoId}#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}" data-video-id="${m.effectiveVideoId}">[${label}]</a>`;
        result = before + pill + after;
      } else if (m.seconds) {
        // No video context: fragment-only fallback with data-timestamp
        const ms = parseInt(m.seconds, 10) * 1000;
        const label = formatTime(ms);
        const pill = `<a href="#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}">[${label}]</a>`;
        result = before + pill + after;
      }
    }

    // Protect our pills with placeholders, then run markdown+escape processing
    const pillPlaceholders: string[] = [];
    let pIdx = 0;

    const withProtectedPills = result.replace(/<a href="[^"]*"[^>]*>.*?<\/a>/g, (match) => {
      const ph = `\x00PIL${pIdx++}\x00`;
      pillPlaceholders.push(match);
      return ph;
    });

    const processed = processText(withProtectedPills);

    return processed.replace(/\x00PIL(\d+)\x00/g, (_match, i) => {
      return pillPlaceholders[parseInt(i, 10)];
    });
  }
}

/** Convenience singleton for direct import usage. */
export const ChatResponseFormatter = new ChatResponseFormatterImpl();