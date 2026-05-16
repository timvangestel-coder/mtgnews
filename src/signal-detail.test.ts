import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from './db/init-db';
import { addChannel } from './db/watchlist';

// -- getSignalById --
import { getSignalById } from './signal-detail';

// -- escapeHtml --
import { escapeHtml } from './signal-detail';

// -- injectTimestampAnchors --
import { injectTimestampAnchors } from './signal-detail';

// -- formatTranscriptionHtml --
import { formatTranscriptionHtml } from './signal-detail';

function createTestDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('signal-detail', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UC1', 'Channel 1');
  });

  afterAll(() => {
    db.close();
  });

  // -- getSignalById --
  describe('getSignalById', () => {
    it('returns signal when video_id exists', () => {
      const vid = 'sig-1';
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(vid, 'UC1', 'Test Signal', '2026-05-01T10:00:00Z',
        JSON.stringify([{ text: 'hello world', start: 0, end: 2.5 }]),
        'AI summary here', 4, Date.now());

      const signal = getSignalById(db, vid);
      expect(signal).not.toBeNull();
      expect(signal!.video_id).toBe(vid);
      expect(signal!.title).toBe('Test Signal');
      expect(signal!.channel_id).toBe('UC1');
    });

    it('returns null when video_id not found', () => {
      const signal = getSignalById(db, 'nonexistent');
      expect(signal).toBeNull();
    });
  });

  // -- escapeHtml --
  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      const result = escapeHtml('<script>alert("xss")</script>');
      expect(result).toContain('\u0026lt;script\u0026gt;');
      expect(result).toContain('\u0026quot;xss\u0026quot;');
      expect(result).not.toContain('<script>');
    });

    it('leaves normal text unchanged', () => {
      expect(escapeHtml('safe text [T:45]')).toBe('safe text [T:45]');
    });
  });

  // -- injectTimestampAnchors --
  describe('injectTimestampAnchors', () => {
    it('converts [T:ss] to anchor links', () => {
      const input = 'Key point [T:45] and another [T:120] done';
      const result = injectTimestampAnchors(input);
      expect(result).toContain('href="#t-45"');
      expect(result).toContain('[T:45]');
      expect(result).toContain('href="#t-120"');
      expect(result).toContain('[T:120]');
    });

    it('leaves text without timestamps unchanged', () => {
      const input = 'no timestamps here';
      expect(injectTimestampAnchors(input)).toBe(input);
    });

    it('html-escapes text before injecting anchors', () => {
      const input = 'bad <b>html</b> [T:10]';
      const result = injectTimestampAnchors(input);
      expect(result).not.toContain('<b>');
      expect(result).toContain('\u0026lt;b\u0026gt;');
    });
  });

  // -- formatTranscriptionHtml --
  describe('formatTranscriptionHtml', () => {
    it('renders transcription segments with t-ss anchors and [T:ss] labels', () => {
      const segments = JSON.stringify([
        { text: 'hello world', start: 0, end: 2.5 },
        { text: 'mtg news', start: 45, end: 48 },
      ]);

      const html = formatTranscriptionHtml(segments);
      expect(html).toContain('id="t-0"');
      expect(html).toContain('[T:0]');
      expect(html).toContain('hello world');
      expect(html).toContain('id="t-45"');
      expect(html).toContain('[T:45]');
      expect(html).toContain('mtg news');
    });

    it('returns empty string for empty transcription', () => {
      expect(formatTranscriptionHtml('[]')).toBe('');
      expect(formatTranscriptionHtml('')).toBe('');
    });

    it('escapes html in segment text', () => {
      const segments = JSON.stringify([
        { text: '<script>alert(1)</script>', start: 10, end: 15 },
      ]);
      const html = formatTranscriptionHtml(segments);
      expect(html).not.toContain('<script>');
      expect(html).toContain('\u0026lt;script\u0026gt;');
    });
  });
});