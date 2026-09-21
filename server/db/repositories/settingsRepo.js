import { all, get, run, parseJson } from '../database.js';
import { nowIso } from '../../lib/ids.js';

/** 设置以 key/value 保存，模型等用户级配置重启后恢复（FR-11 / AC23）。 */
export const settingsRepo = {
  get(key, fallback = null) {
    const row = get('SELECT value FROM settings WHERE key = ?', key);
    return row ? parseJson(row.value, fallback) : fallback;
  },

  set(key, value) {
    run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value ?? null),
      nowIso(),
    );
    return value;
  },

  all() {
    const out = {};
    for (const row of all('SELECT key, value FROM settings')) {
      out[row.key] = parseJson(row.value, null);
    }
    return out;
  },

  updatedAt(key) {
    const row = get('SELECT updated_at FROM settings WHERE key = ?', key);
    return row?.updated_at ?? null;
  },
};
