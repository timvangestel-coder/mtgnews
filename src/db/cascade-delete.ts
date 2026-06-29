import Database from 'better-sqlite3';

/** Shared config: tables that participate in soft-delete cascades. */
const SOFT_DELETE_TABLES = [
  'channels',
  'signals',
  'entity_mentions',
  'signal_chat',
  'poll_run_progress',
] as const;

export interface CascadeResult {
  signalsDeleted: number;
  mentionsDeleted: number;
  chatsDeleted: number;
  progressDeleted: number;
}

export interface SoftDeleteCounts {
  channels: number;
  signals: number;
  mentions: number;
  chats: number;
  progress: number;
}

export interface UndoResult extends SoftDeleteCounts {
  total: number;
}

/**
 * Soft-delete a channel and all related rows in a single transaction.
 * Uses one Date.now() timestamp for all cascaded entities.
 */
export function softDeleteChannel(
  db: Database.Database,
  channelId: string,
): CascadeResult {
  const deletedAt = Date.now();

  const txn = db.transaction((chId: string) => {
    // 1. Soft-delete the channel itself
    db.prepare('UPDATE channels SET deleted_at = ? WHERE channel_id = ?').run(
      deletedAt,
      chId,
    );

    // 2. Soft-delete all signals for this channel
    const sigResult = db.prepare('UPDATE signals SET deleted_at = ? WHERE channel_id = ?').run(
      deletedAt,
      chId,
    );
    const signalsDeleted = sigResult.changes;

    // 3. Soft-delete entity mentions for those signals
    const emResult = db.prepare(
      `UPDATE entity_mentions SET deleted_at = ? WHERE signal_video_id IN (SELECT video_id FROM signals WHERE channel_id = ? AND deleted_at = ?)`,
    ).run(deletedAt, chId, deletedAt);
    const mentionsDeleted = emResult.changes;

    // 4. Soft-delete chat rows: signal-scoped OR topic-scoped for this channel
    const chatResult = db.prepare(
      `UPDATE signal_chat SET deleted_at = ? WHERE (signal_video_id IN (SELECT video_id FROM signals WHERE channel_id = ? AND deleted_at = ?)) OR (channel_id = ? AND signal_video_id IS NULL)`,
    ).run(deletedAt, chId, deletedAt, chId);
    const chatsDeleted = chatResult.changes;

    // 5. Soft-delete poll_run_progress for this channel
    const prpResult = db.prepare(
      'UPDATE poll_run_progress SET deleted_at = ? WHERE channel_id = ?',
    ).run(deletedAt, chId);
    const progressDeleted = prpResult.changes;

    return {
      signalsDeleted,
      mentionsDeleted,
      chatsDeleted,
      progressDeleted,
    };
  });

  return txn(channelId);
}

/**
 * Return counts of rows that would be soft-deleted for a channel, without modifying data.
 */
export function getChannelSoftDeleteCounts(
  db: Database.Database,
  channelId: string,
): CascadeResult {
  const signalsDeleted = db.prepare(
    'SELECT COUNT(*) AS c FROM signals WHERE channel_id = ?',
  ).get(channelId) as { c: number };

  const mentionsDeleted = db.prepare(
    'SELECT COUNT(*) AS c FROM entity_mentions em JOIN signals s ON em.signal_video_id = s.video_id WHERE s.channel_id = ?',
  ).get(channelId) as { c: number };

  const chatsDeleted = db.prepare(
    `SELECT COUNT(*) AS c FROM signal_chat sc
     LEFT JOIN signals s ON sc.signal_video_id = s.video_id
     WHERE (s.channel_id = ? AND sc.signal_video_id IS NOT NULL)
        OR (sc.channel_id = ? AND sc.signal_video_id IS NULL)`,
  ).get(channelId, channelId) as { c: number };

  const progressDeleted = db.prepare(
    'SELECT COUNT(*) AS c FROM poll_run_progress WHERE channel_id = ?',
  ).get(channelId) as { c: number };

  return {
    signalsDeleted: signalsDeleted.c,
    mentionsDeleted: mentionsDeleted.c,
    chatsDeleted: chatsDeleted.c,
    progressDeleted: progressDeleted.c,
  };
}

/**
 * Count soft-deleted rows across all 5 tables.
 */
export function getDbWideSoftDeleteCounts(db: Database.Database): SoftDeleteCounts {
  const channels = db.prepare(
    'SELECT COUNT(*) AS c FROM channels WHERE deleted_at IS NOT NULL',
  ).get() as { c: number };

  const signals = db.prepare(
    'SELECT COUNT(*) AS c FROM signals WHERE deleted_at IS NOT NULL',
  ).get() as { c: number };

  const mentions = db.prepare(
    'SELECT COUNT(*) AS c FROM entity_mentions WHERE deleted_at IS NOT NULL',
  ).get() as { c: number };

  const chats = db.prepare(
    'SELECT COUNT(*) AS c FROM signal_chat WHERE deleted_at IS NOT NULL',
  ).get() as { c: number };

  const progress = db.prepare(
    'SELECT COUNT(*) AS c FROM poll_run_progress WHERE deleted_at IS NOT NULL',
  ).get() as { c: number };

  return {
    channels: channels.c,
    signals: signals.c,
    mentions: mentions.c,
    chats: chats.c,
    progress: progress.c,
  };
}

/**
 * Reset ALL deleted_at values to NULL across all 5 tables in one transaction.
 * Order doesn't matter — setting NULL cannot create FK violations.
 */
export function undoAllSoftDeletes(db: Database.Database): UndoResult {
  const txn = db.transaction(() => {
    const channels = db.prepare(
      'UPDATE channels SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    ).run();

    const signals = db.prepare(
      'UPDATE signals SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    ).run();

    const mentions = db.prepare(
      'UPDATE entity_mentions SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    ).run();

    const chats = db.prepare(
      'UPDATE signal_chat SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    ).run();

    const progress = db.prepare(
      'UPDATE poll_run_progress SET deleted_at = NULL WHERE deleted_at IS NOT NULL',
    ).run();

    return {
      channels: (channels as any).changes,
      signals: (signals as any).changes,
      mentions: (mentions as any).changes,
      chats: (chats as any).changes,
      progress: (progress as any).changes,
    };
  });

  const result = txn();
  return {
    ...result,
    total: result.channels + result.signals + result.mentions + result.chats + result.progress,
  };
}

/**
 * Permanently delete all rows where deleted_at IS NOT NULL.
 * Uses child-first FK order: poll_run_progress → signal_chat → entity_mentions → signals → channels.
 */
export function purgeAllSoftDeleted(db: Database.Database): UndoResult {
  // SOFT_DELETE_TABLES is parent-first; reverse it for child-first deletion
  const purgeOrder = [...SOFT_DELETE_TABLES].reverse();

  const txn = db.transaction(() => {
    const counts: Record<string, number> = {};

    for (const table of purgeOrder) {
      const stmt = db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL`);
      const result = stmt.run();
      counts[table] = (result as any).changes;
    }

    return counts;
  });

  const raw = txn();

  // Map table names to the SoftDeleteCounts keys
  const channels = raw['channels'] ?? 0;
  const signals = raw['signals'] ?? 0;
  const mentions = raw['entity_mentions'] ?? 0;
  const chats = raw['signal_chat'] ?? 0;
  const progress = raw['poll_run_progress'] ?? 0;

  return {
    channels,
    signals,
    mentions,
    chats,
    progress,
    total: channels + signals + mentions + chats + progress,
  };
}