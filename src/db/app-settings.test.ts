import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from './init-db';
import { getAppSetting, setAppSetting, deleteAppSetting } from './app-settings';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

describe('app_settings table (issue #102)', () => {
  it('table is created by initDb with key TEXT PRIMARY KEY and value TEXT', () => {
    const db = createTestDb();

    const columns = db
      .prepare("PRAGMA table_info(app_settings)")
      .all() as Array<{ name: string; type: string }>;

    const columnMap = new Map(columns.map((c) => [c.name, c.type]));

    expect(columnMap.has('key')).toBe(true);
    expect(columnMap.get('key')).toBe('TEXT');
    expect(columnMap.has('value')).toBe(true);
    expect(columnMap.get('value')).toBe('TEXT');
  });

  it('getAppSetting returns null for missing key', () => {
    const db = createTestDb();

    const result = getAppSetting(db, 'nonexistent');

    expect(result).toBeNull();
  });

  it('setAppSetting persists a value and getAppSetting retrieves it', () => {
    const db = createTestDb();

    setAppSetting(db, 'default_summary_prompt', 'My custom global prompt');

    const result = getAppSetting(db, 'default_summary_prompt');

    expect(result).toBe('My custom global prompt');
  });

  it('setAppSetting overwrites an existing value', () => {
    const db = createTestDb();

    setAppSetting(db, 'default_summary_prompt', 'First value');
    setAppSetting(db, 'default_summary_prompt', 'Second value');

    const result = getAppSetting(db, 'default_summary_prompt');

    expect(result).toBe('Second value');
  });

  it('deleteAppSetting removes a key and getAppSetting returns null', () => {
    const db = createTestDb();

    setAppSetting(db, 'default_summary_prompt', 'My custom global prompt');
    expect(getAppSetting(db, 'default_summary_prompt')).toBe('My custom global prompt');

    deleteAppSetting(db, 'default_summary_prompt');

    expect(getAppSetting(db, 'default_summary_prompt')).toBeNull();
  });

  it('deleteAppSetting is idempotent - deleting non-existent key does not throw', () => {
    const db = createTestDb();

    deleteAppSetting(db, 'nonexistent');
    deleteAppSetting(db, 'nonexistent');

    expect(getAppSetting(db, 'nonexistent')).toBeNull();
  });
});