import { all, run, parseJson } from '../database.js';
import { newId, nowIso } from '../../lib/ids.js';
import { redact } from '../../lib/logger.js';

/** 基本操作审计：只记录可核对的事件，不记录任何凭据（FR-01 / 第 7 章）。 */
export const auditRepo = {
  record(actor, action, subject = null, detail = null) {
    run(
      'INSERT INTO audit_events (id, actor, action, subject, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('audit'),
      actor,
      action,
      subject,
      detail ? JSON.stringify(redact(detail)) : null,
      nowIso(),
    );
  },

  list(limit = 200) {
    return all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', limit).map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      detail: parseJson(row.detail_json, null),
      createdAt: row.created_at,
    }));
  },
};
