import { spawn } from 'child_process';
import { readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { mergeOverlappingSegments as _mergeOverlappingSegments } from './transcription-merge';

// Re-export merge module types and functions for backward compatibility
export {
  mergeOverlappingSegments,
  groupSegments,
} from './transcription-merge';
export type {
  RawSegment,
  MergedSegment,
  TranscriptionGroup,
} from './transcription-merge';

/** @deprecated use RawSegment from transcription-merge */
export interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionOptions {
  ytDlpPath?: string;
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
      const segments = _mergeOverlappingSegments(parsed);

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