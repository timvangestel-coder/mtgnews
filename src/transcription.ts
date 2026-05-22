import { spawn } from 'child_process';
import { readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionOptions {
  ytDlpPath?: string;
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
export function mergeOverlappingSegments(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  if (segments.length === 0) return [];
  if (segments.length === 1) return [segments[0]];

  // Phase 1: merge paint-on superset segments
  const merged: TranscriptionSegment[] = [{ ...segments[0] }];

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
export function groupSegments(segments: TranscriptionSegment[]): Array<{ time: number; text: string }> {
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

/**
 * Parse a WebVTT subtitle string into TranscriptionSegment[].
 * VTT timestamp format: HH:MM:SS.mmm or MM:SS.mmm
 */
function parseVtt(vttContent: string): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  const lines = vttContent.split('\n');

  let i = 0;

  // Skip the WEBVTT header
  if (lines[0] && lines[0].startsWith('WEBVTT')) {
    i = 1;
  }

  while (i < lines.length) {
    // Find a timestamp line (format: HH:MM:SS.mmm --> HH:MM:SS.mmm)
    const tsMatch = lines[i].match(/^(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/);

    if (tsMatch) {
      const start = parseVttTimestamp(tsMatch[1]);
      const end = parseVttTimestamp(tsMatch[2]);

      // Collect text lines until the next empty line or timestamp
      i++;
      const textParts: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^\d/)) {
        textParts.push(lines[i].trim());
        i++;
      }

      const rawText = textParts.join(' ').trim();
      // Strip YouTube VTT markup: <c>...</c> cue styles, <nnn> timing markers
      const text = rawText.replace(/<c[^>]*>.*?<\/c>|<c[^>]*\/>|<\d+:\d+:\d+[.,]\d+>/g, '').replace(/\s+/g, ' ').trim();
      if (text && isFinite(start) && isFinite(end)) {
        segments.push({ text, start, end });
      }
    } else {
      i++;
    }
  }

  return segments;
}

/**
 * Parse a VTT timestamp (e.g., "00:00:05.000" or "00:00,500") to milliseconds.
 */
function parseVttTimestamp(ts: string): number {
  // Replace comma with dot for consistent parsing
  const normalized = ts.replace(',', '.');
  const parts = normalized.split(':');

  if (parts.length !== 3) return NaN;

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export async function extractCaptions(
  videoId: string,
  options: TranscriptionOptions = {}
): Promise<TranscriptionSegment[]> {
  const ytDlpPath = options.ytDlpPath || null;

  // Use a temp directory so subtitle files don't pollute the working directory.
  const tempDir = tmpdir();
  const outputTemplate = join(tempDir, `mtgnews_sub_${videoId}.%(ext)s`);

  // yt-dlp writes subtitle files to disk, never to stdout.
  // --sub-format vtt ensures we get .vtt files which are easy to parse.
  // yt-dlp will name them: mtgnews_sub_<videoId>.en.vtt (language appended).
  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-lang', 'en,auto',
    '--sub-format', 'vtt',
    '--no-playlist',
    '-o', outputTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  // Use standalone binary if provided (for tests/custom paths), otherwise fall back to python -m
  const cmd = ytDlpPath || 'python';
  const cmdArgs = ytDlpPath ? [ytDlpPath, ...args] : ['-m', 'yt_dlp', ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', () => {
      // suppress stdout (yt-dlp progress/metadata)
    });

    child.stderr.on('data', () => {
      // suppress stderr for normal operation
    });

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code} for video ${videoId}`));
        return;
      }

      // Find the VTT subtitle file that yt-dlp wrote to the temp directory.
      // yt-dlp names subtitle files as: <output_template>.<LANG>.vtt
      // e.g., mtgnews_sub_abc123.en.vtt
      const files = readdirSync(tempDir);
      const prefix = `mtgnews_sub_${videoId}.`;
      const subFile = files.find(f => f.startsWith(prefix) && f.endsWith('.vtt'));

      if (!subFile) {
        reject(new Error(`No vtt subtitle file found for video ${videoId}`));
        return;
      }

      const filePath = join(tempDir, subFile);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        reject(new Error(`Failed to read subtitle file for video ${videoId}`));
        return;
      }

      const parsed = parseVtt(content);
      const segments = mergeOverlappingSegments(parsed);

      // Clean up the temp subtitle file
      try {
        unlinkSync(filePath);
      } catch {
        // ignore cleanup errors
      }

      resolve(segments);
    });

    child.on('error', (err: Error) => {
      reject(new Error(`yt-dlp failed: ${err.message}`));
    });
  });
}