import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { extractCaptions, TranscriptionSegment, groupSegments } from './transcription';

// Use vi.hoisted() so mocks are available in hoisted vi.mock factories
const { mockSpawn, mockReaddirSync, mockReadFileSync, mockUnlinkSync, mockTmpdir, mockJoin } = vi.hoisted(() => {
  return {
    mockSpawn: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockTmpdir: vi.fn(() => '/tmp'),
    mockJoin: (...args: string[]) => args.join('/'),
  };
});

// Mock modules (hoisted, must use vi.hoisted() mocks above)
vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('fs', () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('os', () => ({
  tmpdir: mockTmpdir,
}));

vi.mock('path', () => ({
  join: mockJoin,
}));

describe('transcription', () => {
  describe('groupSegments', () => {
    it('groups segments within 10s windows, concatenating text with spaces', () => {
      const segments: TranscriptionSegment[] = [
        { text: 'hello world', start: 0, end: 5000 },
        { text: 'mtg news', start: 5000, end: 8000 },
        { text: 'today folks', start: 45000, end: 48000 },
      ];

      const result = groupSegments(segments);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ time: 0, text: 'hello world mtg news' });
      expect(result[1]).toEqual({ time: 45000, text: 'today folks' });
    });

    it('returns single segment as-is', () => {
      const segments: TranscriptionSegment[] = [
        { text: 'only one', start: 1000, end: 3000 },
      ];

      const result = groupSegments(segments);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ time: 1000, text: 'only one' });
    });

    it('returns empty array for empty input', () => {
      const result = groupSegments([]);
      expect(result).toEqual([]);
    });

    it('rounds non-round timestamps to nearest second (milliseconds)', () => {
      const segments: TranscriptionSegment[] = [
        { text: 'first', start: 4150, end: 5000 },
        { text: 'second', start: 14523, end: 16000 },
      ];

      const result = groupSegments(segments);

      expect(result).toHaveLength(2);
      expect(result[0].time).toBe(4000);
      expect(result[0].text).toBe('first');
      expect(result[1].time).toBe(15000);
      expect(result[1].text).toBe('second');
    });
  });

  describe('extractCaptions', () => {
    const sampleVtt = `WEBVTT

00:00:00.000 --> 00:00:02.500
hello world

00:00:02.500 --> 00:00:05.000
mtg news today
`;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterAll(() => {
      vi.restoreAllMocks();
    });

    it('parses caption segments from VTT subtitle file', async () => {
      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
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

      // Mock fs: yt-dlp wrote a VTT file to temp dir
      mockReaddirSync.mockReturnValue(['mtgnews_sub_dQw4w9WgXcQ.en.vtt']);
      mockReadFileSync.mockReturnValue(sampleVtt);

      const segments = await extractCaptions('dQw4w9WgXcQ');

      expect(segments).toHaveLength(2);
      expect(segments[0].text).toBe('hello world');
      expect(segments[0].start).toBe(0);
      expect(segments[0].end).toBe(2500);
      expect(segments[1].text).toBe('mtg news today');
      expect(segments[1].start).toBe(2500);
      expect(segments[1].end).toBe(5000);
    });

    it('rejects when no subtitle file found', async () => {
      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
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

      // Mock fs: no subtitle file found
      mockReaddirSync.mockReturnValue([]);
      mockReadFileSync.mockReturnValue('');

      await expect(extractCaptions('no-caps-video')).rejects.toThrow('No vtt subtitle file found');
    });

    it('rejects when yt-dlp exits with error code', async () => {
      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
          },
          stderr: {
            on: () => stream,
          },
          on: (event: string, cb: (data: Buffer | number) => void) => {
            if (event === 'close') cb(1);
            return stream;
          },
        };
        return stream as any;
      });

      await expect(extractCaptions('bad-video')).rejects.toThrow('yt-dlp exited with code 1');
    });

    it('merges overlapping paint-on segments from YouTube auto-captions', async () => {
      // Real-world YouTube auto-caption pattern: overlapping segments where
      // each segment is a superset of the previous one (paint-on effect)
      const overlappingVtt = `WEBVTT

00:00:04.150 --> 00:00:05.000
Folks,

00:00:04.160 --> 00:00:06.000
Folks, welcome

00:00:05.670 --> 00:00:08.140
welcome back. My name is Rudy. You're

00:00:05.680 --> 00:00:10.000
welcome back. My name is Rudy. You're watching
`;

      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
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

      mockReaddirSync.mockReturnValue(['mtgnews_sub_overlap123.en.vtt']);
      mockReadFileSync.mockReturnValue(overlappingVtt);

      const segments = await extractCaptions('overlap123');

      // 4 overlapping segments merge into 2, then "welcome" trimmed from segment 2
      expect(segments).toHaveLength(2);
      expect(segments[0].text).toBe('Folks, welcome');
      expect(segments[0].start).toBe(4150);
      expect(segments[1].text).toBe('back. My name is Rudy. You\'re watching');
      expect(segments[1].start).toBe(5670);
    });

    it('strips YouTube VTT markup tags from text', async () => {
      const vttWithMarkup = `WEBVTT

00:00:01.000 --> 00:00:03.000
welcome<c> back</c><00:00:01.500> to the show
`;

      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: {
            on: () => stream,
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

      mockReaddirSync.mockReturnValue(['mtgnews_sub_test123.en.vtt']);
      mockReadFileSync.mockReturnValue(vttWithMarkup);

      const segments = await extractCaptions('test123');

      // <c> back</c> is a YouTube styling tag, not text content — it gets stripped
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe('welcome to the show');
    });

    it('decodes HTML entities from VTT captions (speaker markers)', async () => {
      // YouTube encodes speaker change markers >> as >> in VTT
      const amp = String.fromCharCode(38);
      const vttWithEntities = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello everyone ${amp}gt;${amp}gt; Pretty good, how are you?
`;

      mockSpawn.mockImplementation(() => {
        const stream = {
          stdout: { on: () => stream },
          stderr: { on: () => stream },
          on: (event: string, cb: (data: Buffer | number) => void) => {
            if (event === 'close') cb(0);
            return stream;
          },
        };
        return stream as any;
      });

      mockReaddirSync.mockReturnValue(['mtgnews_sub_entity123.en.vtt']);
      mockReadFileSync.mockReturnValue(vttWithEntities);

      const segments = await extractCaptions('entity123');

      expect(segments).toHaveLength(1);
      // >> must be decoded to >> — not left as raw entity strings
      expect(segments[0].text).toBe('Hello everyone >> Pretty good, how are you?');
    });
  });
});
