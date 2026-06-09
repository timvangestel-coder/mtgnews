/**
 * Deep module for transforming LLM citation delimiters into clickable HTML pill links.
 * Pure function: no DB access, no side effects.
 * Delegates to TimestampFormatter for remaining timestamp formatting.
 *
 * Handles multiple LLM output formats:
 * - <videoId:T:ss> — proper citation with videoId and seconds
 * - T:ss or [T:ss] — bare timestamps in seconds
 * - [MM:SS] — minute:second timestamps (LLM common output)
 * - Malformed citations like <videold:xxx: that should be stripped but still provide context
 */

import { TimestampFormatter } from './timestamp-formatter';

const PILL_CLASSES = 'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors';

interface SignalInfo {
  title: string;
}

/**
 * Format milliseconds to MM:SS display string.
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface CitationFormatter {
  /**
   * Transform citation delimiters and timestamps into clickable pill anchor links.
   */
  format(text: string, signalMap: Record<string, SignalInfo>): string;
}

export class CitationFormatterImpl implements CitationFormatter {
  format(text: string, signalMap: Record<string, SignalInfo>): string {
    // Collect ALL matches with positions.
    type Match = { pos: number; len: number; videoId?: string; seconds: string };
    const allMatches: Match[] = [];

    // Pattern 1: <videoId:T:ss> — proper citation format
    text.replace(/<([A-Za-z0-9_-]+):T:(\d+)>/g, (_match, videoId, seconds, pos) => {
      allMatches.push({ pos, len: _match.length, videoId, seconds });
      return _match;
    });

    // Pattern 1b: Malformed citations — <xxx:videoId: where xxx is not "T" and videoId matches signalMap
    // e.g. <videold:QMn7cm4nfYU: or <videoId:abc123def: — strip these but use for context
    text.replace(/<([A-Za-z0-9_-]+):([A-Za-z0-9_-]{5,}):/g, (_match, prefix, candidateVideoId, pos) => {
      if (prefix !== 'T' && signalMap[candidateVideoId]) {
        allMatches.push({ pos, len: _match.length, videoId: candidateVideoId });
      }
      return _match;
    });

    // Pattern 2: [MM:SS] — minute:second timestamps (LLM common output)
    text.replace(/\[(\d{1,3}):(\d{2})\]/g, (_match, minsStr, secsStr, pos) => {
      const mins = parseInt(minsStr, 10);
      const secs = parseInt(secsStr, 10);
      // Only treat as timestamp if seconds is valid (0-59) and not already covered
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

    // Annotate each match with the effective videoId (inherited from last citation/malformed citation)
    let lastVideoId: string | undefined;
    const annotated = sorted.map(m => {
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
      const m = annotated[i];
      const before = result.substring(0, m.pos);
      const after = result.substring(m.pos + m.len);

      if (m.videoId && signalMap[m.videoId]) {
        // Citation or malformed citation — remove the raw text and establish context
        // If it has a timestamp too, create a proper pill link
        if (m.seconds) {
          const ms = parseInt(m.seconds, 10) * 1000;
          const label = formatTime(ms);
          const pill = `<a href="/signals/${m.videoId}#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}">${signalMap[m.videoId].title} &middot; [${label}]</a>`;
          result = before + pill + after;
        } else {
          // Malformed citation without timestamp — just remove the raw text (no visible output)
          result = before + after;
        }
      } else if (m.effectiveVideoId && signalMap[m.effectiveVideoId] && m.seconds) {
        // Bare timestamp: use inherited videoId for absolute link (not fragment)
        const ms = parseInt(m.seconds, 10) * 1000;
        const label = formatTime(ms);
        const pill = `<a href="/signals/${m.effectiveVideoId}#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}">[${label}]</a>`;
        result = before + pill + after;
      } else if (m.seconds) {
        // No video context: fragment-only fallback
        const ms = parseInt(m.seconds, 10) * 1000;
        const label = formatTime(ms);
        const pill = `<a href="#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}">[${label}]</a>`;
        result = before + pill + after;
      }
    }

    // Delegate to TimestampFormatter for markdown conversion + HTML escaping
    // of the plain-text parts. The <a> tags we inserted are already HTML and
    // must survive — but TimestampFormatter.processText() escapes angle brackets.
    // So we protect our pills with placeholders, then restore them.
    const pillPlaceholders: string[] = [];
    let pIdx = 0;

    const withProtectedPills = result.replace(/<a href="[^"]*"[^>]*>.*?<\/a>/g, (match) => {
      const ph = `\x00PIL${pIdx++}\x00`;
      pillPlaceholders.push(match);
      return ph;
    });

    const processed = TimestampFormatter.format(withProtectedPills);

    return processed.replace(/\x00PIL(\d+)\x00/g, (_match, i) => {
      return pillPlaceholders[parseInt(i, 10)];
    });
  }
}

/** Convenience singleton for direct import usage. */
export const CitationFormatter = new CitationFormatterImpl();