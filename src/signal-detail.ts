import Database from 'better-sqlite3';
import { SignalRow } from './query';

/** Return the display title: generated_title if available, otherwise original title, otherwise a fallback. */
export function displayTitleForSignal(signal: SignalRow, fallback = 'Signal Detail'): string {
  return signal.generated_title || signal.title || fallback;
}

export function getSignalById(db: Database.Database, videoId: string): SignalRow | null {
  const row = db.prepare(
    'SELECT video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, sentiment_label, created_at, processing_state, generated_title FROM signals WHERE video_id = ?'
  ).get(videoId) as SignalRow | undefined;
  return row ?? null;
}

const PILL_CLASSES = 'inline-flex items-center bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-sm font-medium hover:bg-indigo-200 transition-colors';

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
