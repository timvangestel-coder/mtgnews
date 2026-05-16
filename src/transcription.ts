import { spawn } from 'child_process';

export interface TranscriptionSegment {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionOptions {
  ytDlpPath?: string;
}

export async function extractCaptions(
  videoId: string,
  options: TranscriptionOptions = {}
): Promise<TranscriptionSegment[]> {
  const ytDlpPath = options.ytDlpPath || 'yt-dlp';

  const args = [
    '--skip-download',
    '--write-sub',
    '--write-auto-sub',
    '--sub-lang', 'en',
    '--convert-subs', 'json3',
    '--dump-json',
    '--no-playlist',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    child.stderr.on('data', () => {
      // suppress stderr for normal operation
    });

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code} for video ${videoId}`));
        return;
      }

      const output = Buffer.concat(chunks).toString('utf-8');
      const segments = parseCaptions(output);
      resolve(segments);
    });

    child.on('error', (err: Error) => {
      reject(new Error(`yt-dlp failed: ${err.message}`));
    });
  });
}

function parseCaptions(output: string): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      // json3 subtitle format: flat {text, start, end} per line
      if (parsed.text && typeof parsed.start === 'number' && typeof parsed.end === 'number') {
        segments.push({
          text: parsed.text,
          start: parsed.start,
          end: parsed.end,
        });
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return segments;
}
