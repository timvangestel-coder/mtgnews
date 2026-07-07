import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addChannel } from './db/watchlist';
import { createTopic, listTopics } from './db/watchlist';
import {
  QueryFilters,
  QueryResult,
  EntityTrending,
  querySignals,
  getEntityTrending,
} from './query';
import { createTestDb } from '../tests/fixtures/test-db';

function insertSignal(
  db: Database.Database,
  videoId: string,
  channelId: string,
  publishedAt: string,
  sentiment: number,
  entities: { name: string; type: string; sentiment: string }[] = []
) {
  db.prepare(
    `INSERT INTO signals (video_id, channel_id, title, published_at, transcription, overall_sentiment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(videoId, channelId, `Title ${videoId}`, publishedAt, '[]', sentiment, Date.now());

  for (const e of entities) {
    db.prepare(
      `INSERT INTO entity_mentions (signal_video_id, entity_name, entity_type, sentiment)
       VALUES (?, ?, ?, ?)`
    ).run(videoId, e.name, e.type, e.sentiment);
  }
}

describe('query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createTopic(db, 'esports', 'Esports', 'esports');
    createTopic(db, 'politics', 'Politics', 'politics');
    const topics = listTopics(db);
    addChannel(db, 'UC1', 'Channel 1', undefined, topics[0].id);
    addChannel(db, 'UC2', 'Channel 2', undefined, topics[1].id);

    // seed 5 signals across 2 channels, varying sentiment + dates
    insertSignal(db, 'v1', 'UC1', '2026-01-01T00:00:00Z', 3, [{ name: 'Koma', type: 'Player', sentiment: 'positive' }]);
    insertSignal(db, 'v2', 'UC1', '2026-02-01T00:00:00Z', 5, [{ name: 'Koma', type: 'Player', sentiment: 'positive' }, { name: 'Moondog', type: 'Player', sentiment: 'neutral' }]);
    insertSignal(db, 'v3', 'UC2', '2026-03-01T00:00:00Z', 1, [{ name: 'Moondog', type: 'Player', sentiment: 'negative' }]);
    insertSignal(db, 'v4', 'UC2', '2026-04-01T00:00:00Z', 4, [{ name: 'Johan', type: 'Player', sentiment: 'positive' }]);
    insertSignal(db, 'v5', 'UC1', '2026-05-01T00:00:00Z', 2, [{ name: 'Koma', type: 'Player', sentiment: 'negative' }]);
  });

  afterAll(() => {
    db.close();
  });

  // -- Filter by channel --
  it('filter by channel ID returns only matching signals', () => {
    const result = querySignals(db, { channelId: 'UC1' });
    expect(result.items).toHaveLength(3);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v5', 'v2', 'v1']);
  });

  // -- Filter by date range --
  it('filter by date range returns signals within period', () => {
    const result = querySignals(db, {
      dateFrom: '2026-02-01T00:00:00Z',
      dateTo: '2026-04-01T00:00:00Z',
    });
    expect(result.items).toHaveLength(3);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v4', 'v3', 'v2']);
  });

  // -- Filter by sentiment --
  it('filter by min sentiment returns signals >= threshold', () => {
    const result = querySignals(db, { minSentiment: 4 });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v4', 'v2']);
  });

  it('filter by max sentiment returns signals <= threshold', () => {
    const result = querySignals(db, { maxSentiment: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v5', 'v3']);
  });

  it('filter by sentiment range returns signals within bounds', () => {
    const result = querySignals(db, { minSentiment: 2, maxSentiment: 4 });
    expect(result.items).toHaveLength(3);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v5', 'v4', 'v1']);
  });

  // -- Filter by entity mention --
  it('filter by entity mention returns signals where entity appears', () => {
    const result = querySignals(db, { entityMention: 'Koma' });
    expect(result.items).toHaveLength(3);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v5', 'v2', 'v1']);
  });

  it('filter by entity mention returns empty when entity not found', () => {
    const result = querySignals(db, { entityMention: 'Unknown' });
    expect(result.items).toHaveLength(0);
  });

  // -- Combined filters --
  it('combined channel + sentiment filters work', () => {
    const result = querySignals(db, { channelId: 'UC1', minSentiment: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v2', 'v1']);
  });

  it('combined channel + date range + entity filters work', () => {
    const result = querySignals(db, {
      channelId: 'UC1',
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-03-01T00:00:00Z',
      entityMention: 'Koma',
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v2', 'v1']);
  });

  // -- Pagination --
  it('pagination returns correct page with offset/limit', () => {
    const page1 = querySignals(db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items.map((s: any) => s.video_id)).toEqual(['v5', 'v4']);
    expect(page1.total).toBe(5);

    const page2 = querySignals(db, { limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((s: any) => s.video_id)).toEqual(['v3', 'v2']);
    expect(page2.total).toBe(5);

    const page3 = querySignals(db, { limit: 2, offset: 4 });
    expect(page3.items).toHaveLength(1);
    expect(page3.items.map((s: any) => s.video_id)).toEqual(['v1']);
  });

  it('default page size is 25', () => {
    const result = querySignals(db);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  // -- Entity trending --
  it('entity trending returns frequency-sorted list with average sentiment', () => {
    const trending = getEntityTrending(db);
    // Koma: 3 mentions (pos, pos, neg) -> avg sentiment mapped from text
    // Moondog: 2 mentions (neutral, neg)
    // Johan: 1 mention (pos)
    expect(trending[0].entity_name).toBe('Koma');
    expect(trending[0].mention_count).toBe(3);
    expect(trending[0].entity_type).toBe('Player');

    expect(trending[1].entity_name).toBe('Moondog');
    expect(trending[1].mention_count).toBe(2);

    expect(trending[2].entity_name).toBe('Johan');
    expect(trending[2].mention_count).toBe(1);
  });

  it('entity trending sorted by mention_count desc', () => {
    const trending = getEntityTrending(db);
    for (let i = 1; i < trending.length; i++) {
      expect(trending[i].mention_count).toBeLessThanOrEqual(trending[i - 1].mention_count);
    }
  });

  // -- Relevance filter (Issue #47, migrated to processing_state in #88) --
  it('default (no includeIrrelevant) excludes signals with processing_state=irrelevant', () => {
    // Mark v3 as irrelevant
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v3');

    const result = querySignals(db);
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).not.toContain('v3');
    expect(result.total).toBe(4);
  });

  it('includeIrrelevant: true includes irrelevant signals', () => {
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v3');

    const result = querySignals(db, { includeIrrelevant: true });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).toContain('v3');
    expect(result.total).toBe(5);
  });

  it('includeIrrelevant: false excludes irrelevant signals (explicit)', () => {
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v3');

    const result = querySignals(db, { includeIrrelevant: false });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).not.toContain('v3');
    expect(result.total).toBe(4);
  });

  it('includeIrrelevant works with channel filter combined', () => {
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v2'); // UC1 signal
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v3'); // UC2 signal

    // Default: exclude irrelevant, filter by UC1 -> should get v5, v1 (v2 excluded)
    const result = querySignals(db, { channelId: 'UC1' });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).toEqual(['v5', 'v1']);
    expect(result.total).toBe(2);

    // Include irrelevant, filter by UC1 -> should get v5, v2, v1
    const result2 = querySignals(db, { channelId: 'UC1', includeIrrelevant: true });
    const ids2 = result2.items.map((s: any) => s.video_id);
    expect(ids2).toEqual(['v5', 'v2', 'v1']);
    expect(result2.total).toBe(3);
  });

  it('signals with processing_state=irrelevant return correct state in row', () => {
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v4');

    const result = querySignals(db, { includeIrrelevant: true });
    const v4Row = result.items.find((s: any) => s.video_id === 'v4');
    expect(v4Row).toBeDefined();
    expect(v4Row!.processing_state).toBe('irrelevant');
  });

  it('signals with default processing_state=pending are always included', () => {
    // v1-v5 all have processing_state='pending' by default
    const result = querySignals(db);
    expect(result.total).toBe(5);
  });

  // -- Issue #115: generated_title in SignalRow --
  it('query includes generated_title column in results', () => {
    // Set generated_title on v1
    db.prepare("UPDATE signals SET generated_title = ? WHERE video_id = ?").run('AI Generated Title for V1', 'v1');

    const result = querySignals(db);
    const v1Row = result.items.find((s: any) => s.video_id === 'v1');
    expect(v1Row).toBeDefined();
    expect(v1Row!.generated_title).toBe('AI Generated Title for V1');
  });

  it('generated_title is null when not set', () => {
    const result = querySignals(db);
    const v2Row = result.items.find((s: any) => s.video_id === 'v2');
    expect(v2Row).toBeDefined();
    expect(v2Row!.generated_title).toBeNull();
  });

  it('generated_title is included with channel filter', () => {
    db.prepare("UPDATE signals SET generated_title = ? WHERE video_id = ?").run('Custom Title V5', 'v5');

    const result = querySignals(db, { channelId: 'UC1' });
    const v5Row = result.items.find((s: any) => s.video_id === 'v5');
    expect(v5Row!.generated_title).toBe('Custom Title V5');
  });

  it('generated_title is included for irrelevant signals', () => {
    db.prepare("UPDATE signals SET processing_state = ? WHERE video_id = ?").run('irrelevant', 'v3');
    db.prepare("UPDATE signals SET generated_title = ? WHERE video_id = ?").run('Irrelevant Signal Title', 'v3');

    const result = querySignals(db, { includeIrrelevant: true });
    const v3Row = result.items.find((s: any) => s.video_id === 'v3');
    expect(v3Row!.generated_title).toBe('Irrelevant Signal Title');
    expect(v3Row!.processing_state).toBe('irrelevant');
  });

  // -- Topic filter (Issue #56) --
  it('topicKey filters signals to only that topic channels', () => {
    const result = querySignals(db, { topicKey: 'esports' });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).not.toContain('v3');
    expect(ids).not.toContain('v4');
    expect(result.total).toBe(3);
  });

  it('topicKey with nonMatching key returns empty', () => {
    const result = querySignals(db, { topicKey: 'nonexistent' });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('topicKey combined with channelId works', () => {
    const result = querySignals(db, { topicKey: 'esports', channelId: 'UC1' });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).toEqual(['v5', 'v2', 'v1']);
    expect(result.total).toBe(3);
  });

  it('topicKey with channelId from different topic returns empty', () => {
    const result = querySignals(db, { topicKey: 'esports', channelId: 'UC2' });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('empty topicKey returns all signals', () => {
    const result = querySignals(db, { topicKey: '' });
    expect(result.total).toBe(5);
  });

  it('topicKey with pagination works', () => {
    const page1 = querySignals(db, { topicKey: 'esports', limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = querySignals(db, { topicKey: 'esports', limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it('topicKey combined with date and sentiment filters', () => {
    const result = querySignals(db, { topicKey: 'esports', minSentiment: 3, dateFrom: '2026-01-01T00:00:00Z' });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((s: any) => s.video_id)).toEqual(['v2', 'v1']);
  });

  // -- Issue #116: Q&A Ratio --
  it('signal with no chat rows has null qaAnswered and qaTotal', () => {
    const result = querySignals(db);
    const v1Row = result.items.find((s: any) => s.video_id === 'v1');
    expect(v1Row!.qaAnswered).toBeNull();
    expect(v1Row!.qaTotal).toBeNull();
  });

  it('signal with one answered question shows 1/1 ratio', () => {
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v1', 'What is this about?', 'It is about MTG.');

    const result = querySignals(db);
    const v1Row = result.items.find((s: any) => s.video_id === 'v1');
    expect(v1Row!.qaAnswered).toBe(1);
    expect(v1Row!.qaTotal).toBe(1);
  });

  it('signal with multiple questions including failed ones counts correctly', () => {
    // 2 answered, 1 failed (NULL answer)
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v2', 'Question 1?', 'Answer 1');
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v2', 'Question 2?', 'Answer 2');
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v2', 'Question 3?', null);

    const result = querySignals(db);
    const v2Row = result.items.find((s: any) => s.video_id === 'v2');
    expect(v2Row!.qaAnswered).toBe(2);
    expect(v2Row!.qaTotal).toBe(3);
  });

  it('signal with only failed questions shows 0 answered but correct total', () => {
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v3', 'Failed question?', null);
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v3', 'Another failed?', null);

    const result = querySignals(db);
    const v3Row = result.items.find((s: any) => s.video_id === 'v3');
    expect(v3Row!.qaAnswered).toBe(0);
    expect(v3Row!.qaTotal).toBe(2);
  });

  it('qa ratio works with channel filter', () => {
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v5', 'UC1 question?', 'UC1 answer');

    const result = querySignals(db, { channelId: 'UC1' });
    const v5Row = result.items.find((s: any) => s.video_id === 'v5');
    expect(v5Row!.qaAnswered).toBe(1);
    expect(v5Row!.qaTotal).toBe(1);

    // v1 and v2 have no chat in UC1 filter
    const v1Row = result.items.find((s: any) => s.video_id === 'v1');
    expect(v1Row!.qaAnswered).toBeNull();
    expect(v1Row!.qaTotal).toBeNull();
  });

  // -- Issue #183: reviewed flag --
  it('default query includes both reviewed and unreviewed signals', () => {
    // Mark v1 as reviewed
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1');

    const result = querySignals(db);
    expect(result.total).toBe(5);
  });

  it('includeUnreviewed: false excludes reviewed signals', () => {
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1');
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v2');

    const result = querySignals(db, { includeUnreviewed: false });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).not.toContain('v1');
    expect(ids).not.toContain('v2');
    expect(result.total).toBe(3);
  });

  it('includeUnreviewed: true includes all signals regardless of reviewed status', () => {
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1');

    const result = querySignals(db, { includeUnreviewed: true });
    expect(result.total).toBe(5);
  });

  it('includeUnreviewed treats NULL reviewed as unreviewed', () => {
    // All signals have reviewed=NULL or reviewed=0 by default -> all are unreviewed
    const result = querySignals(db, { includeUnreviewed: false });
    expect(result.total).toBe(5);
  });

  it('includeUnreviewed works combined with channel filter', () => {
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1'); // UC1
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v5'); // UC1

    // Filter by UC1, exclude reviewed -> only v2 remains
    const result = querySignals(db, { channelId: 'UC1', includeUnreviewed: false });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).toEqual(['v2']);
    expect(result.total).toBe(1);
  });

  it('includeUnreviewed works combined with topic filter', () => {
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1'); // UC1 -> esports
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v3'); // UC2 -> politics

    // Filter by esports topic, exclude reviewed -> v5, v2 remain
    const result = querySignals(db, { topicKey: 'esports', includeUnreviewed: false });
    const ids = result.items.map((s: any) => s.video_id);
    expect(ids).toEqual(['v5', 'v2']);
    expect(result.total).toBe(2);
  });

  it('signal row includes reviewed column', () => {
    db.prepare("UPDATE signals SET reviewed = ? WHERE video_id = ?").run(1, 'v1');

    const result = querySignals(db);
    const v1Row = result.items.find((s: any) => s.video_id === 'v1');
    expect(v1Row!.reviewed).toBe(1);

    const v2Row = result.items.find((s: any) => s.video_id === 'v2');
    expect(v2Row!.reviewed).toBe(0);
  });
});
