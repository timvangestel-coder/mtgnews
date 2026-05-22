import Database from 'better-sqlite3';
import { SignalRow } from './query';

export function getSignalById(db: Database.Database, videoId: string): SignalRow | null {
  const row = db.prepare(
    'SELECT video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at, processed_at FROM signals WHERE video_id = ?'
  ).get(videoId) as SignalRow | undefined;
  return row ?? null;
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '\u0026amp;',
    '<': '\u0026lt;',
    '>': '\u0026gt;',
    '"': '\u0026quot;',
    "'": '\u0026#39;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Convert T:ss timestamps in LLM summaries to clickable [MM:SS] anchor links.
 * The LLM produces timestamps as "T:ss" (bare) or "[T:ss]" (bracketed) where ss is integer seconds.
 * The transcription anchors use millisecond IDs (e.g., #t-45000).
 * Display the link as [MM:SS] for readability.
 */
const PILL_CLASSES = 'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors';

export function injectTimestampAnchors(text: string): string {
  const escaped = escapeHtml(text);
  // Match both [T:ss] and bare T:ss (with word boundary to avoid partial matches)
  return escaped.replace(/(?:\[)?(T:(\d+))(?:\])?/g, (_match, ref, seconds) => {
    const ms = parseInt(seconds, 10) * 1000;
    const label = formatTime(ms);
    return `<a href="#t-${ms}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${ms}">[${label}]</a>`;
  });
}

/**
 * Format milliseconds as [HH:MM] or [MM:SS].
 * Since video timestamps are typically minutes-level, format as [MM:SS].
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTranscriptionHtml(transcriptionJson: string): string {
  if (!transcriptionJson) return '';

  let groups: Array<{ time: number; text: string }> = [];
  try {
    groups = JSON.parse(transcriptionJson);
  } catch {
    return '';
  }

  if (!groups.length) return '';

  return groups
    .map((group) => {
      const timeLabel = formatTime(group.time);
      const safeText = escapeHtml(group.text);
      return `<p id="t-${group.time}" class="transcript-segment mb-2"><a href="#t-${group.time}" rel="nofollow noreferrer" class="${PILL_CLASSES}" data-timestamp="${group.time}">[${timeLabel}]</a> ${safeText}</p>`;
    })
    .join('\n');
}
