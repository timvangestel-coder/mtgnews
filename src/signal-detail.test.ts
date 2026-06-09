import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addChannel } from './db/watchlist';

// -- getSignalById --
import { getSignalById } from './signal-detail';

// -- escapeHtml --
import { escapeHtml } from './signal-detail';

// -- formatTranscriptionHtml --
import { formatTranscriptionHtml, displayTitleForSignal } from './signal-detail';

import { createTestDb } from '../tests/fixtures/test-db';

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
        JSON.stringify([{ time: 0, text: 'hello world' }]),
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

  // -- displayTitleForSignal --
  describe('displayTitleForSignal', () => {
    it('returns generated_title when available', () => {
      const result = displayTitleForSignal({
        title: 'Original YouTube Title',
        generated_title: 'AI Generated Title',
      } as SignalRow);
      expect(result).toBe('AI Generated Title');
    });

    it('falls back to original title when generated_title is null', () => {
      const result = displayTitleForSignal({
        title: 'Original YouTube Title',
        generated_title: null,
      } as SignalRow);
      expect(result).toBe('Original YouTube Title');
    });

    it('falls back to default when both are null', () => {
      const result = displayTitleForSignal({
        title: null,
        generated_title: null,
      } as SignalRow);
      expect(result).toBe('Signal Detail');
    });
  });

  // -- formatTranscriptionHtml --
  describe('formatTranscriptionHtml', () => {
    it('renders grouped transcription with [MM:SS] timestamps', () => {
      const grouped = JSON.stringify([
        { time: 0, text: 'hello world mtg news' },
        { time: 45000, text: 'today folks' },
      ]);

      const html = formatTranscriptionHtml(grouped);
      expect(html).toContain('id="t-0"');
      expect(html).toContain('[00:00]');
      expect(html).toContain('hello world mtg news');
      expect(html).toContain('id="t-45000"');
      expect(html).toContain('[00:45]');
      expect(html).toContain('today folks');
    });

    it('renders segment timestamps as clickable pill badges', () => {
      const grouped = JSON.stringify([
        { time: 45000, text: 'today folks' },
      ]);

      const html = formatTranscriptionHtml(grouped);
      // Timestamp should be a clickable pill link
      expect(html).toContain('bg-indigo-100');
      expect(html).toContain('text-indigo-700');
      expect(html).toContain('px-2');
      expect(html).toContain('rounded');
      // Should be a link with data-timestamp attribute for bidirectional linking
      expect(html).toContain('data-timestamp="45000"');
    });

    it('renders rounded millisecond timestamps correctly', () => {
      const grouped = JSON.stringify([
        { time: 4000, text: 'first segment' },
        { time: 15000, text: 'second segment' },
      ]);

      const html = formatTranscriptionHtml(grouped);
      expect(html).toContain('id="t-4000"');
      expect(html).toContain('[00:04]');
      expect(html).toContain('id="t-15000"');
      expect(html).toContain('[00:15]');
    });

    it('returns empty string for empty transcription', () => {
      expect(formatTranscriptionHtml('[]')).toBe('');
      expect(formatTranscriptionHtml('')).toBe('');
    });

    it('escapes html in group text', () => {
      const grouped = JSON.stringify([
        { time: 10000, text: '<script>alert(1)</script>' },
      ]);
      const html = formatTranscriptionHtml(grouped);
      expect(html).not.toContain('<script>');
      expect(html).toContain('\u0026lt;script\u0026gt;');
    });

    it('renders multiple groups as separate paragraphs', () => {
      const grouped = JSON.stringify([
        { time: 60000, text: 'first part second part third part' },
        { time: 70000, text: 'fourth part' },
      ]);

      const html = formatTranscriptionHtml(grouped);
      expect(html).toContain('[01:00]');
      expect(html).toContain('[01:10]');
      const paragraphCount = (html.match(/<p /g) || []).length;
      expect(paragraphCount).toBe(2);
    });
  });
});