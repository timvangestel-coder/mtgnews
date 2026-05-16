import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { extractCaptions, TranscriptionSegment } from './transcription';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('transcription', () => {
  describe('extractCaptions', () => {
    it('parses caption segments from yt-dlp JSON output', async () => {
      vi.mocked(spawn).mockImplementation(() => {
        const stream = {
          stdout: {
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === 'data') {
                cb(
                  Buffer.from(
                    JSON.stringify({ text: 'hello world', start: 0.0, end: 2.5 }) + '\n' +
                    JSON.stringify({ text: 'mtg news today', start: 2.5, end: 5.0 }) + '\n'
                  )
                );
              }
              return stream;
            },
          },
          stderr: {
            on: () => stream,
          },
          on: (event: string, cb: (data: Buffer | number) => void) => {
            if (event === 'close') cb(0);
            return stream;
          },
        };
        return stream as any;
      });

      const segments = await extractCaptions('dQw4w9WgXcQ');

      expect(segments).toHaveLength(2);
      expect(segments[0]).toEqual({ text: 'hello world', start: 0.0, end: 2.5 });
      expect(segments[1]).toEqual({ text: 'mtg news today', start: 2.5, end: 5.0 });
    });

    it('returns empty array when no captions available', async () => {
      vi.mocked(spawn).mockImplementation(() => {
        const stream = {
          stdout: {
            on: (event: string, cb: (data: Buffer) => void) => {
              return stream;
            },
          },
          stderr: {
            on: () => stream,
          },
          on: (event: string, cb: (data: Buffer | number) => void) => {
            if (event === 'close') cb(0);
            return stream;
          },
        };
        return stream as any;
      });

      const segments = await extractCaptions('no-caps-video');
      expect(segments).toEqual([]);
    });

    it('rejects when yt-dlp exits with error code', async () => {
      vi.mocked(spawn).mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
          },
          stderr: {
            on: () => stream,
          },
          on: (event: string, cb: (data: Buffer | number) => void) => {
            if (event === 'error') cb(new Error('no subtitles'));
            if (event === 'close') cb(1);
            return stream;
          },
        };
        return stream as any;
      });

      await expect(extractCaptions('bad-video')).rejects.toThrow();
    });
  });
});
