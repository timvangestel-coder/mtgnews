import Database from 'better-sqlite3';

/**
 * Delete a video signal and all related entity mentions from the database.
 * @returns true if the video was found and deleted, false if not found.
 */
export function deleteVideo(db: Database.Database, videoId: string): boolean {
  // Check if signal exists
  const existing = db.prepare('SELECT video_id FROM signals WHERE video_id = ?').get(videoId);
  if (!existing) return false;

  // Delete entity mentions first (FK child)
  db.prepare('DELETE FROM entity_mentions WHERE signal_video_id = ?').run(videoId);

  // Delete the signal
  db.prepare('DELETE FROM signals WHERE video_id = ?').run(videoId);

  return true;
}