/**
 * SpeechService — generates TTS audio for signal summaries using gspeak.
 *
 * Pipeline:
 *  1. Query signals.summary from DB by video_id
 *  2. Strip timestamp markers via stripTimestamps()
 *  3. Check disk cache — if exists, serve cached file
 *  4. Otherwise, call gspeak, write buffer to disk, serve
 *
 * Cache strategy: data/mp3/{video_id}.mp3 on disk
 *
 * The route handler calls res.sendFile() with the returned path;
 * no ReadStream is returned here (avoids lazy-open cleanup issues in tests).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { gSpeak } from 'gspeak';
import { stripTimestamps } from '../strip-timestamps';

const MP3_DIR = path.join(__dirname, '..', '..', 'data', 'mp3');

export class SpeechService {
  constructor(private db: Database.Database) {}

  /**
   * Generate or retrieve cached TTS audio for a signal's summary.
   * Returns the absolute file path, or null if no summary exists.
   */
  async generate(videoId: string): Promise<string | null> {
    // 1. Query summary from DB
    const row = this.db.prepare('SELECT summary FROM signals WHERE video_id = ?').get(videoId) as { summary: string | null } | undefined;
    if (!row || !row.summary) {
      return null;
    }

    // 2. Strip timestamps
    const cleanText = stripTimestamps(row.summary);

    // 3. Ensure mp3 directory exists
    fs.mkdirSync(MP3_DIR, { recursive: true });

    const mp3Path = path.join(MP3_DIR, `${videoId}.mp3`);

    // 4. Check disk cache
    if (fs.existsSync(mp3Path)) {
      return mp3Path;
    }

    // 5. Generate audio via gspeak
    try {
      const tts = new gSpeak(cleanText, 'en');
      const audioStream = tts.stream();

      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      // Write to disk
      fs.writeFileSync(mp3Path, buffer);

      return mp3Path;
    } catch (err) {
      // Clean up partial file on error
      if (fs.existsSync(mp3Path)) {
        fs.unlinkSync(mp3Path);
      }
      throw err;
    }
  }
}
