import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, paths } from '../config.js';
import { migrations } from './migrations.js';
import { logger } from '../lib/logger.js';

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      logger.info(`已应用数据库迁移 ${migration.id}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

export function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** node:sqlite 只接受 null/number/string/bigint/Buffer，这里统一归一化。 */
export const sqlValue = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
};

const bind = (params) => params.map(sqlValue);

export const run = (sql, ...params) => getDb().prepare(sql).run(...bind(params));
export const all = (sql, ...params) => getDb().prepare(sql).all(...bind(params));
export const get = (sql, ...params) => getDb().prepare(sql).get(...bind(params)) ?? null;

export const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
