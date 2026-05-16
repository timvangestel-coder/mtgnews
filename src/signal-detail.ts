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

export function injectTimestampAnchors(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/\[T:(\d+)\]/g, '<a href="#t-$1" rel="nofollow noreferrer">[T:$1]</a>');
}

export function formatTranscriptionHtml(transcriptionJson: string): string {
  if (!transcriptionJson) return '';

  let segments: Array<{ text: string; start: number; end: number }> = [];
  try {
    segments = JSON.parse(transcriptionJson);
  } catch {
    return '';
  }

  if (!segments.length) return '';

  return segments
    .map((seg) => {
      const safeText = escapeHtml(seg.text);
      return `<p id="t-${seg.start}" class="transcript-segment mb-2"><strong>[T:${seg.start}]</strong> ${safeText}</p>`;
    })
    .join('\n');
}