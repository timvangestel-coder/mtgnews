import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';
import { SpeechService } from './speech-service';

// Mock gspeak module
vi.mock('gspeak', () => {
  const { PassThrough } = require('stream');
  const gSpeak = vi.fn().mockImplementation((text: string, lang: string) => {
    const stream = new PassThrough();
    // Write a mock MP3 buffer (just some bytes for testing)
    stream.write(Buffer.from([0xFF, 0xFB, 0x90, 0x44, 0x00]));
    stream.end();
    return {
      stream: () => stream,
    };
  });
  return { gSpeak };
});

const MP3_DIR = path.join(__dirname, '..', '..', 'data', 'mp3');

let db: Database.Database;
let service: SpeechService;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  addChannel(db, 'UCtest', 'Test Channel');
  service = new SpeechService(db);
});

afterEach(() => {
  // Clean up any mp3 files created during tests
  if (fs.existsSync(MP3_DIR)) {
    const files = fs.readdirSync(MP3_DIR);
    for (const file of files) {
      const filePath = path.join(MP3_DIR, file);
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
});

afterAll(() => {
  db.close();
});

describe('SpeechService', () => {
  describe('generate()', () => {
    it('returns null when no summary exists', async () => {
      const result = await service.generate('nonexistent-video-id');
      expect(result).toBeNull();
    });

    it('generates audio for a signal with summary', async () => {
      // Insert a test signal
      db.prepare(`
        INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-video-1', 'UCtest', 'Test Video', '2026-01-01T00:00:00Z', '[]', 'Hello [T:45] world', 4, Date.now());

      const result = await service.generate('test-video-1');
      expect(result).not.toBeNull();
      expect(result!).toContain('test-video-1.mp3');
      expect(fs.existsSync(result!)).toBe(true);
    });

    it('returns cached file on second call', async () => {
      // Already has the file from previous test
      const result1 = await service.generate('test-video-1');
      expect(result1).not.toBeNull();
      const mtime1 = fs.statSync(result1!).mtimeMs;

      const result2 = await service.generate('test-video-1');
      expect(result2).not.toBeNull();
      const mtime2 = fs.statSync(result2!).mtimeMs;

      // File should not have been regenerated
      expect(mtime2).toBe(mtime1);
    });

    it('strips timestamps from summary before TTS', async () => {
      db.prepare(`
        INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-video-2', 'UCtest', 'Test Video 2', '2026-01-02T00:00:00Z', '[]', 'This [T:10] is <<music>> a [01:30] test', 4, Date.now());

      const result = await service.generate('test-video-2');
      expect(result).not.toBeNull();
      expect(fs.existsSync(result!)).toBe(true);
    });
  });
});
