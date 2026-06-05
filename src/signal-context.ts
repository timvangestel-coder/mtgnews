import Database from 'better-sqlite3';
import { getAppSetting } from './db/app-settings';

export interface SignalContext {
  transcriptionJson: string;
  topicId: number;
  filterText: string;
  summaryPrompt: string | null;
}

export function resolveSignalContext(videoId: string, db: Database.Database): SignalContext {
  const row = db.prepare(`
    SELECT s.transcription, t.id AS topic_id, t.filter_text, t.summary_prompt
    FROM signals s
    JOIN channels c ON s.channel_id = c.channel_id
    LEFT JOIN topics t ON c.topic_id = t.id
    WHERE s.video_id = ?
  `).get(videoId) as
    | { transcription: string; topic_id: number | null; filter_text: string | null; summary_prompt: string | null }
    | undefined;

  if (!row) {
    throw new Error(`Signal ${videoId} not found`);
  }

  // Three-tier resolution: topic override → DB global default → null (PromptAssembler code fallback)
  const summaryPrompt = row.summary_prompt
    ?? getAppSetting(db, 'default_summary_prompt')
    ?? null;

  return {
    transcriptionJson: row.transcription,
    topicId: row.topic_id ?? 0,
    filterText: row.filter_text ?? '',
    summaryPrompt,
  };
}
