import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../tests/fixtures/test-db';
import {
  softDeleteChannel,
  getChannelSoftDeleteCounts,
  getDbWideSoftDeleteCounts,
  undoAllSoftDeletes,
  purgeAllSoftDeleted,
} from './cascade-delete';

describe('cascade-delete module', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it('softDeleteChannel sets deleted_at on channel and cascades to signals, mentions, chats, progress', () => {
    // Seed: channel + signal + mention + chat + poll_run_progress
    const now = Date.now();
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC1', 'Test Channel', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v1', 'UC1', 'Signal 1', '[]', now);
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
    ).run('v1', 'Karn');
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v1', 'What card?', 'Karn Liberated');
    // poll_run_progress row for this channel
    db.prepare(
      "INSERT INTO poll_runs (triggered_at, status) VALUES (?, ?)"
    ).run(now, 'active');
    const runId = db.prepare('SELECT id FROM poll_runs ORDER BY id DESC LIMIT 1').get() as { id: number };
    db.prepare(
      "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(runId.id, 'UC1', 'fetching', 0, now);

    const result = softDeleteChannel(db, 'UC1');

    // Channel is soft-deleted
    const ch = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC1') as { deleted_at: number | null };
    expect(ch?.deleted_at).toBeGreaterThan(0);

    // Signal is soft-deleted
    const sig = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v1') as { deleted_at: number | null };
    expect(sig?.deleted_at).toBeGreaterThan(0);

    // Entity mention is soft-deleted
    const em = db.prepare('SELECT deleted_at FROM entity_mentions WHERE id = 1').get() as { deleted_at: number | null };
    expect(em?.deleted_at).toBeGreaterThan(0);

    // Chat row is soft-deleted
    const chat = db.prepare('SELECT deleted_at FROM signal_chat WHERE id = 1').get() as { deleted_at: number | null };
    expect(chat?.deleted_at).toBeGreaterThan(0);

    // Poll run progress is soft-deleted
    const prp = db.prepare('SELECT deleted_at FROM poll_run_progress WHERE id = 1').get() as { deleted_at: number | null };
    expect(prp?.deleted_at).toBeGreaterThan(0);

    // Result counts are correct
    expect(result.signalsDeleted).toBe(1);
    expect(result.mentionsDeleted).toBe(1);
    expect(result.chatsDeleted).toBe(1);
    expect(result.progressDeleted).toBe(1);
  });

  it('softDeleteChannel uses single timestamp across all cascaded entities', () => {
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC2', 'Timestamp Channel', Date.now());
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v2', 'UC2', 'Signal 2', '[]', Date.now());

    softDeleteChannel(db, 'UC2');

    const ch = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC2') as { deleted_at: number };
    const sig = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v2') as { deleted_at: number };

    expect(ch.deleted_at).toBe(sig.deleted_at);
  });

  it('softDeleteChannel cascades to multiple signals and their mentions', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC3', 'Multi Signal Channel', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v3a', 'UC3', 'Signal A', '[]', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v3b', 'UC3', 'Signal B', '[]', now);
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
    ).run('v3a', 'Entity A');
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
    ).run('v3b', 'Entity B1');
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
    ).run('v3b', 'Entity B2');

    const result = softDeleteChannel(db, 'UC3');

    expect(result.signalsDeleted).toBe(2);
    expect(result.mentionsDeleted).toBe(3);

    // Verify all signals deleted
    const sigA = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v3a') as { deleted_at: number | null };
    const sigB = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v3b') as { deleted_at: number | null };
    expect(sigA?.deleted_at).toBeGreaterThan(0);
    expect(sigB?.deleted_at).toBeGreaterThan(0);

    // Verify all mentions deleted
    const mentionCount = db.prepare("SELECT COUNT(*) AS c FROM entity_mentions WHERE deleted_at IS NULL").get() as { c: number };
    expect(mentionCount.c).toBe(0);
  });

  it('softDeleteChannel does not affect rows belonging to other channels', () => {
    const now = Date.now();
    // Channel UC4 with signal v4
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC4', 'Delete Me', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v4', 'UC4', 'Signal 4', '[]', now);

    // Channel UC5 with signal v5 — should NOT be affected
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC5', 'Keep Me', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v5', 'UC5', 'Signal 5', '[]', now);

    softDeleteChannel(db, 'UC4');

    // UC4 signal is deleted
    const sig4 = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v4') as { deleted_at: number | null };
    expect(sig4?.deleted_at).toBeGreaterThan(0);

    // UC5 signal is NOT deleted
    const sig5 = db.prepare('SELECT deleted_at FROM signals WHERE video_id = ?').get('v5') as { deleted_at: number | null };
    expect(sig5?.deleted_at).toBeNull();

    // UC5 channel is NOT deleted
    const ch5 = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC5') as { deleted_at: number | null };
    expect(ch5?.deleted_at).toBeNull();
  });

  it('softDeleteChannel handles topic-scoped chat (channel_id set, signal_video_id NULL)', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC6', 'Topic Scope Channel', now);

    // Topic-scoped chat row: channel_id = UC6, signal_video_id IS NULL
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, channel_id) VALUES (NULL, ?, ?, ?)"
    ).run('General question?', 'General answer', 'UC6');

    softDeleteChannel(db, 'UC6');

    // Topic-scoped chat for UC6 should be deleted
    const chat = db.prepare(
      "SELECT deleted_at FROM signal_chat WHERE channel_id = 'UC6' AND signal_video_id IS NULL"
    ).get() as { deleted_at: number | null };
    expect(chat?.deleted_at).toBeGreaterThan(0);
  });

  it('softDeleteChannel does NOT delete topic-scoped chat with channel_id=NULL', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC7', 'Topic Scope Channel 2', now);

    // Topic-scoped chat: channel_id IS NULL — should survive
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer, channel_id) VALUES (NULL, ?, ?, NULL)"
    ).run('All channels question?', 'All channels answer');

    softDeleteChannel(db, 'UC7');

    // Topic-scoped chat with NULL channel_id should NOT be deleted
    const chat = db.prepare(
      "SELECT deleted_at FROM signal_chat WHERE channel_id IS NULL"
    ).get() as { deleted_at: number | null };
    expect(chat?.deleted_at).toBeNull();
  });

  it('softDeleteChannel returns zero counts when channel has no related data', () => {
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC8', 'Empty Channel', Date.now());

    const result = softDeleteChannel(db, 'UC8');

    expect(result.signalsDeleted).toBe(0);
    expect(result.mentionsDeleted).toBe(0);
    expect(result.chatsDeleted).toBe(0);
    expect(result.progressDeleted).toBe(0);

    // Channel itself is still soft-deleted
    const ch = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC8') as { deleted_at: number | null };
    expect(ch?.deleted_at).toBeGreaterThan(0);
  });

  describe('getDbWideSoftDeleteCounts', () => {
    it('returns zero counts when no soft-deleted rows exist', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC100', 'Active Channel', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v100', 'UC100', 'Signal', '[]', now);

      const counts = getDbWideSoftDeleteCounts(db);

      expect(counts.channels).toBe(0);
      expect(counts.signals).toBe(0);
      expect(counts.mentions).toBe(0);
      expect(counts.chats).toBe(0);
      expect(counts.progress).toBe(0);
    });

    it('returns correct counts after soft-deleting a channel', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC101', 'Count Channel', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v101a', 'UC101', 'Signal A', '[]', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v101b', 'UC101', 'Signal B', '[]', now);
      db.prepare(
        "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)",
      ).run('v101a', 'Entity 1');
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)",
      ).run('v101b', 'Q?', 'A!');

      softDeleteChannel(db, 'UC101');

      const counts = getDbWideSoftDeleteCounts(db);

      expect(counts.channels).toBe(1);
      expect(counts.signals).toBe(2);
      expect(counts.mentions).toBe(1);
      expect(counts.chats).toBe(1);
      expect(counts.progress).toBe(0);
    });
  });

  describe('undoAllSoftDeletes', () => {
    it('resets all deleted_at to NULL across all 5 tables in one transaction', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC200', 'Undo Channel', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v200', 'UC200', 'Signal', '[]', now);
      db.prepare(
        "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)",
      ).run('v200', 'Entity');
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)",
      ).run('v200', 'Q?', 'A!');

      // Create poll_run_progress row
      db.prepare("INSERT INTO poll_runs (triggered_at, status) VALUES (?, ?)").run(now, 'active');
      const runId = db.prepare('SELECT id FROM poll_runs ORDER BY id DESC LIMIT 1').get() as { id: number };
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(runId.id, 'UC200', 'fetching', 0, now);

      softDeleteChannel(db, 'UC200');

      // Verify all are soft-deleted
      let counts = getDbWideSoftDeleteCounts(db);
      expect(counts.channels).toBe(1);
      expect(counts.signals).toBe(1);
      expect(counts.mentions).toBe(1);
      expect(counts.chats).toBe(1);
      expect(counts.progress).toBe(1);

      // Undo all
      const result = undoAllSoftDeletes(db);

      expect(result.channels).toBe(1);
      expect(result.signals).toBe(1);
      expect(result.mentions).toBe(1);
      expect(result.chats).toBe(1);
      expect(result.progress).toBe(1);
      expect(result.total).toBe(5);

      // Verify all deleted_at are NULL again
      counts = getDbWideSoftDeleteCounts(db);
      expect(counts.channels).toBe(0);
      expect(counts.signals).toBe(0);
      expect(counts.mentions).toBe(0);
      expect(counts.chats).toBe(0);
      expect(counts.progress).toBe(0);

      // Verify rows still exist (soft delete was undone, not purged)
      const chExists = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE channel_id = ?').get('UC200') as { c: number };
      expect(chExists.c).toBe(1);
    });

    it('returns zero counts when no soft-deleted rows exist', () => {
      const result = undoAllSoftDeletes(db);
      expect(result.total).toBe(0);
      expect(result.channels).toBe(0);
      expect(result.signals).toBe(0);
      expect(result.mentions).toBe(0);
      expect(result.chats).toBe(0);
      expect(result.progress).toBe(0);
    });
  });

  describe('purgeAllSoftDeleted', () => {
    it('permanently deletes all soft-deleted rows in FK order (child-first)', () => {
      const now = Date.now();
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC300', 'Purge Channel', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v300a', 'UC300', 'Signal A', '[]', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v300b', 'UC300', 'Signal B', '[]', now);
      db.prepare(
        "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)",
      ).run('v300a', 'Entity 1');
      db.prepare(
        "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)",
      ).run('v300b', 'Entity 2');
      db.prepare(
        "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)",
      ).run('v300a', 'Q?', 'A!');

      // Create poll_run_progress row
      db.prepare("INSERT INTO poll_runs (triggered_at, status) VALUES (?, ?)").run(now, 'active');
      const runId = db.prepare('SELECT id FROM poll_runs ORDER BY id DESC LIMIT 1').get() as { id: number };
      db.prepare(
        "INSERT INTO poll_run_progress (poll_run_id, channel_id, status, signals_found, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(runId.id, 'UC300', 'fetching', 0, now);

      softDeleteChannel(db, 'UC300');

      // Verify all are soft-deleted
      let counts = getDbWideSoftDeleteCounts(db);
      expect(counts.channels).toBe(1);
      expect(counts.signals).toBe(2);
      expect(counts.mentions).toBe(2);
      expect(counts.chats).toBe(1);
      expect(counts.progress).toBe(1);

      // Purge all
      const result = purgeAllSoftDeleted(db);

      expect(result.channels).toBe(1);
      expect(result.signals).toBe(2);
      expect(result.mentions).toBe(2);
      expect(result.chats).toBe(1);
      expect(result.progress).toBe(1);
      expect(result.total).toBe(7);

      // Verify rows are permanently gone (not just soft-deleted)
      const chCount = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE channel_id = ?').get('UC300') as { c: number };
      expect(chCount.c).toBe(0);

      const sigCount = db.prepare("SELECT COUNT(*) AS c FROM signals WHERE video_id IN ('v300a', 'v300b')").get() as { c: number };
      expect(sigCount.c).toBe(0);

      // Soft-delete count should be zero
      counts = getDbWideSoftDeleteCounts(db);
      expect(counts.channels).toBe(0);
      expect(counts.signals).toBe(0);
      expect(counts.mentions).toBe(0);
      expect(counts.chats).toBe(0);
      expect(counts.progress).toBe(0);
    });

    it('does not affect non soft-deleted rows', () => {
      const now = Date.now();
      // Soft-delete this channel
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC301', 'Purge Me', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v301', 'UC301', 'Signal', '[]', now);

      // Keep this channel active
      db.prepare(
        'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)',
      ).run('UC302', 'Keep Me', now);
      db.prepare(
        "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run('v302', 'UC302', 'Signal', '[]', now);

      softDeleteChannel(db, 'UC301');

      const result = purgeAllSoftDeleted(db);

      expect(result.channels).toBe(1);
      expect(result.signals).toBe(1);

      // UC302 and its signal must still exist
      const chKeep = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE channel_id = ?').get('UC302') as { c: number };
      expect(chKeep.c).toBe(1);

      const sigKeep = db.prepare('SELECT COUNT(*) AS c FROM signals WHERE video_id = ?').get('v302') as { c: number };
      expect(sigKeep.c).toBe(1);
    });

    it('returns zero counts when no soft-deleted rows exist', () => {
      const result = purgeAllSoftDeleted(db);
      expect(result.total).toBe(0);
      expect(result.channels).toBe(0);
      expect(result.signals).toBe(0);
      expect(result.mentions).toBe(0);
      expect(result.chats).toBe(0);
      expect(result.progress).toBe(0);
    });
  });

  it('getChannelSoftDeleteCounts returns accurate counts without modifying data', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO channels (channel_id, display_name, added_at) VALUES (?, ?, ?)'
    ).run('UC9', 'Count Channel', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v9a', 'UC9', 'Signal A', '[]', now);
    db.prepare(
      "INSERT INTO signals (video_id, channel_id, title, transcription, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('v9b', 'UC9', 'Signal B', '[]', now);
    db.prepare(
      "INSERT INTO entity_mentions (signal_video_id, entity_name) VALUES (?, ?)"
    ).run('v9a', 'Entity 1');
    db.prepare(
      "INSERT INTO signal_chat (signal_video_id, question, answer) VALUES (?, ?, ?)"
    ).run('v9b', 'Question?', 'Answer!');

    const counts = getChannelSoftDeleteCounts(db, 'UC9');

    expect(counts.signalsDeleted).toBe(2);
    expect(counts.mentionsDeleted).toBe(1);
    expect(counts.chatsDeleted).toBe(1);
    expect(counts.progressDeleted).toBe(0);

    // Verify no data was modified — all deleted_at are still NULL
    const ch = db.prepare('SELECT deleted_at FROM channels WHERE channel_id = ?').get('UC9') as { deleted_at: number | null };
    expect(ch?.deleted_at).toBeNull();

    const sigCount = db.prepare("SELECT COUNT(*) AS c FROM signals WHERE deleted_at IS NOT NULL").get() as { c: number };
    expect(sigCount.c).toBe(0);
  });
});