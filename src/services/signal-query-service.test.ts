import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../db/init-db';
import { addChannel } from '../db/watchlist';
import { SignalQueryService } from './signal-query-service';
vi.mock('../llm', () => ({
  analyzeSignal: vi.fn(),
  getLlmConfig: () => ({ endpoint: 'http://localhost:1234/v1/chat/completions', model: 'test' }),
}));
import { analyzeSignal } from '../llm';

let db: Database.Database;
let service: SignalQueryService;

beforeAll(() => {
  db = new Database(':memory:');
  initDb(db);
  service = new SignalQueryService(db);
});

afterAll(() => {
  db.close();
});

describe('SignalQueryService', () => {
  describe('listSignals()', () => {
    it('returns empty list when no signals exist', () => {
      const result = service.listSignals({});
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns all signals when no filters', () => {
      const t = Date.now();
      addChannel(db, `UClist${t}`, 'List Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`v1-${t}`, `UClist${t}`, 'Video One', `2103-12-31T00:00:00Z`, '[]', 'summary one', 4, Date.now());
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`v2-${t}`, `UClist${t}`, 'Video Two', `2103-06-30T00:00:00Z`, '[]', 'summary two', 3, Date.now());

      const result = service.listSignals({});
      expect(result.total).toBe(2);
      expect(result.items.length).toBe(2);
      // ordered by published_at DESC
      expect(result.items[0].video_id).toBe(`v1-${t}`);
      expect(result.items[1].video_id).toBe(`v2-${t}`);
    });

    it('filters by channelId', () => {
      const t = Date.now();
      addChannel(db, `UCchA${t}`, 'Channel A');
      addChannel(db, `UCchB${t}`, 'Channel B');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`va-${t}`, `UCchA${t}`, 'A Video', `2103-12-31T00:00:00Z`, '[]', 'a summary', 4, Date.now());
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vb-${t}`, `UCchB${t}`, 'B Video', `2103-12-30T00:00:00Z`, '[]', 'b summary', 4, Date.now());

      const result = service.listSignals({ channelId: `UCchA${t}` });
      expect(result.total).toBe(1);
      expect(result.items[0].video_id).toBe(`va-${t}`);
    });

    it('excludes irrelevant signals by default', () => {
      const t = Date.now();
      addChannel(db, `UCirr${t}`, 'Irr Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vrel-${t}`, `UCirr${t}`, 'Relevant', `2103-12-31T00:00:00Z`, '[]', 'relevant summary', 4, Date.now());
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, relevance_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`virr-${t}`, `UCirr${t}`, 'Irrelevant', `2103-12-30T00:00:00Z`, '[]', 'irrelevant summary', 4, 'irrelevant', Date.now());

      // Filter by this channel to isolate from other test data
      const result = service.listSignals({ channelId: `UCirr${t}` });
      expect(result.total).toBe(1);
      expect(result.items[0].video_id).toBe(`vrel-${t}`);
    });

    it('includes irrelevant signals when includeIrrelevant=true', () => {
      const t = Date.now();
      addChannel(db, `UCirr2${t}`, 'Irr2 Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, relevance_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`virr2-${t}`, `UCirr2${t}`, 'Irrelevant 2', `2103-12-29T00:00:00Z`, '[]', 'irrelevant summary 2', 4, 'irrelevant', Date.now());

      const result = service.listSignals({ includeIrrelevant: true });
      // Only count signals for this channel (other tests' irrelevant signals are on different channels)
      const irrResult = service.listSignals({ channelId: `UCirr2${t}`, includeIrrelevant: true });
      expect(irrResult.total).toBe(1);
      expect(irrResult.items[0].relevance_status).toBe('irrelevant');
    });

    it('respects pagination limit and offset', () => {
      const t = Date.now();
      addChannel(db, `UCpage${t}`, 'Page Channel');
      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`vpage${i}-${t}`, `UCpage${t}`, `Page Video ${i}`, `2103-01-${String(i).padStart(2,'0')}T00:00:00Z`, '[]', `summary ${i}`, 3, Date.now());
      }

      const result = service.listSignals({ channelId: `UCpage${t}`, limit: 3 });
      expect(result.items.length).toBe(3);
      expect(result.total).toBe(5);
    });
  });

  describe('getSignalDetail()', () => {
    it('returns null for nonexistent signal', () => {
      const result = service.getSignalDetail('nonexistent');
      expect(result).toBeNull();
    });

    it('returns signal with formatted summary and transcription HTML', () => {
      const t = Date.now();
      addChannel(db, `UCdetail${t}`, 'Detail Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `vdetail-${t}`, `UCdetail${t}`, 'Detail Video', `2103-12-31T00:00:00Z`,
        JSON.stringify([{ time: 0, text: 'hello world' }, { time: 45000, text: 'mtg news' }]),
        'Summary with [T:45] timestamp', 4, Date.now()
      );

      const result = service.getSignalDetail(`vdetail-${t}`);
      expect(result).not.toBeNull();
      expect(result!.signal.video_id).toBe(`vdetail-${t}`);
      expect(result!.channel).toBeDefined();
      expect(result!.summaryHtml).toContain('href="#t-45000"');
      expect(result!.summaryHtml).toContain('[00:45]');
      expect(result!.transcriptionHtml).toContain('id="t-0"');
      expect(result!.transcriptionHtml).toContain('hello world');
    });

    it('escapes HTML in summary to prevent XSS', () => {
      const t = Date.now();
      addChannel(db, `UCxss${t}`, 'XSS Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, summary, overall_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`vxss-${t}`, `UCxss${t}`, 'XSS Video', `2103-12-31T00:00:00Z`, '[]', '<script>alert("xss")</script>', 4, Date.now());

      const result = service.getSignalDetail(`vxss-${t}`);
      expect(result).not.toBeNull();
      expect(result!.summaryHtml).not.toContain('<script>alert');
    });

    it('returns empty HTML when summary/transcription are null', () => {
      const t = Date.now();
      addChannel(db, `UCempty${t}`, 'Empty Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`vempty-${t}`, `UCempty${t}`, 'Empty Video', `2103-12-31T00:00:00Z`, '', Date.now());

      const result = service.getSignalDetail(`vempty-${t}`);
      expect(result).not.toBeNull();
      expect(result!.summaryHtml).toBe('');
    });
  });

  describe('summarizeSignal()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns error for nonexistent signal', async () => {
      const result = await service.summarizeSignal('nonexistent-xyz');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(analyzeSignal).not.toHaveBeenCalled();
    });

    it('delegates to analyzeSignal for existing signal', async () => {
      const t = Date.now();
      addChannel(db, `UCsum${t}`, 'Sum Channel');
      db.prepare(
        `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`vsum-${t}`, `UCsum${t}`, 'Summarize Me', `2103-12-31T00:00:00Z`, '[]', Date.now());

      (analyzeSignal as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

      const result = await service.summarizeSignal(`vsum-${t}`);
      expect(analyzeSignal).toHaveBeenCalledWith(db, `vsum-${t}`, expect.objectContaining({ endpoint: expect.any(String) }));
      expect(result.success).toBe(true);
    });
  });
});