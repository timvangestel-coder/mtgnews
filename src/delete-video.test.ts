import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addChannel } from './db/watchlist';
import { deleteVideo } from './delete-video';
import { createTestDb } from '../tests/fixtures/test-db';

function insertSignal(
  db: Database.Database,
  videoId: string,
  channelId: string,
  entities: { name: string; type: string; sentiment: string }[] = []
) {
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, channelId, `Title ${videoId}`, '2026-01-01T00:00:00Z', '[]', 3, Date.now());

  for (const e of entities) {
    db.prepare(
      `INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment)
       VALUES (?, ?, ?, ?)`
    ).run(videoId, e.name, e.type, e.sentiment);
  }
}

describe('deleteVideo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addChannel(db, 'UC1', 'Channel 1');

    insertSignal(db, 'v1', 'UC1', [{ name: 'Koma', type: 'Player', sentiment: 'positive' }]);
    insertSignal(db, 'v2', 'UC1', [{ name: 'Moondog', type: 'Player', sentiment: 'neutral' }, { name: 'Johan', type: 'Player', sentiment: 'negative' }]);
    insertSignal(db, 'v3', 'UC1');
  });

  afterAll(() => {
    db.close();
  });

  it('removes signal and related entity mentions', () => {
    deleteVideo(db, 'v2');

    const signals = db.prepare('SELECT video_id FROM signals').all() as { video_id: string }[];
    expect(signals.map((s) => s.video_id).sort()).toEqual(['v1', 'v3'].sort());

    const mentions = db.prepare('SELECT signal_video_id FROM entity_mentions').all() as { signal_video_id: string }[];
    expect(mentions.map((m) => m.signal_video_id)).toEqual(['v1']);
  });

  it('removes signal with no entities', () => {
    deleteVideo(db, 'v3');

    const signals = db.prepare('SELECT video_id FROM signals').all() as { video_id: string }[];
    expect(signals.map((s) => s.video_id).sort()).toEqual(['v1', 'v2'].sort());

    const mentions = db.prepare('SELECT signal_video_id FROM entity_mentions').all() as { signal_video_id: string }[];
    expect(mentions.map((m) => m.signal_video_id).sort()).toEqual(['v1', 'v2', 'v2'].sort());
  });

  it('does nothing when video id not found', () => {
    deleteVideo(db, 'nonexistent');

    const signals = db.prepare('SELECT video_id FROM signals').all() as { video_id: string }[];
    expect(signals).toHaveLength(3);

    const mentions = db.prepare('SELECT signal_video_id FROM entity_mentions').all() as { signal_video_id: string }[];
    expect(mentions).toHaveLength(3);
  });

  it('returns true when video was deleted', () => {
    const result = deleteVideo(db, 'v1');
    expect(result).toBe(true);
  });

  it('returns false when video not found', () => {
    const result = deleteVideo(db, 'nonexistent');
    expect(result).toBe(false);
  });
});