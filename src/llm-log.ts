import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(__dirname, '..', 'log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** Generate a timestamped filename safe for all OS file systems */
function timestampFilename(prefix: string, ext: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-'); // e.g. 2026-06-19T15-53-59-123Z
  return `${prefix}-${ts}.${ext}`;
}

/** Write the LLM request (what is sent to the LLM) to a log file */
export function logRequest(payload: unknown): string {
  ensureLogDir();
  const filename = timestampFilename('req', 'json');
  const filepath = path.join(LOG_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');
  return filepath;
}

/** Write the LLM response (what the LLM responds back) to a log file */
export function logResponse(response: unknown): string {
  ensureLogDir();
  const filename = timestampFilename('resp', 'json');
  const filepath = path.join(LOG_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(response, null, 2), 'utf-8');
  return filepath;
}

/** Write a streaming response accumulated as a string to a log file */
export function logStreamResponse(content: string): string {
  ensureLogDir();
  const filename = timestampFilename('resp-stream', 'txt');
  const filepath = path.join(LOG_DIR, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}