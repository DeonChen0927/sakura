import { all, get, run } from '../database.js';
import { newId, nowIso } from '../../lib/ids.js';

/**
 * 跨轮次发现跟踪（FR-08）。
 * 本轮未再提及不等于已修复，系统只能给出“无法确认”，由人工显式改判。
 */
export const CarryoverVerdict = {
  STILL_PRESENT: 'still_present',
  FIXED: 'fixed',
  UNVERIFIABLE: 'unverifiable',
};

const mapRow = (row) =>
  row && {
    id: row.id,
    roundId: row.round_id,
    previousRoundId: row.previous_round_id,
    previousRoundNumber: row.previous_round_number ?? null,
    previousFindingId: row.previous_finding_id,
    currentFindingId: row.current_finding_id,
    verdict: row.verdict,
    note: row.note,
    decidedBy: row.decided_by,
    updatedAt: row.updated_at,
    finding: row.finding_key
      ? {
          key: row.finding_key,
          severity: row.severity,
          titleZh: row.title_zh,
          filePath: row.file_path,
          newLine: row.new_line,
        }
      : null,
  };

export const carryoverRepo = {
  upsert(entry) {
    const existing = get(
      'SELECT id FROM finding_carryover WHERE round_id = ? AND previous_finding_id = ?',
      entry.roundId,
      entry.previousFindingId,
    );
    const id = existing?.id ?? newId('carry');
    run(
      `INSERT INTO finding_carryover (
         id, round_id, previous_round_id, previous_finding_id, current_finding_id,
         verdict, note, decided_by, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, previous_finding_id) DO UPDATE SET
         current_finding_id = excluded.current_finding_id,
         verdict = excluded.verdict,
         note = excluded.note,
         decided_by = excluded.decided_by,
         updated_at = excluded.updated_at`,
      id,
      entry.roundId,
      entry.previousRoundId,
      entry.previousFindingId,
      entry.currentFindingId ?? null,
      entry.verdict,
      entry.note ?? null,
      entry.decidedBy ?? 'system',
      nowIso(),
    );
    return this.byId(id);
  },

  byId(id) {
    return mapRow(
      get(
        `SELECT c.*, f.finding_key, f.severity, f.title_zh, f.file_path, f.new_line,
                r.round_number AS previous_round_number
         FROM finding_carryover c
         JOIN findings f ON f.id = c.previous_finding_id
         JOIN review_rounds r ON r.id = c.previous_round_id
         WHERE c.id = ?`,
        id,
      ),
    );
  },

  listByRound(roundId) {
    return all(
      `SELECT c.*, f.finding_key, f.severity, f.title_zh, f.file_path, f.new_line,
              r.round_number AS previous_round_number
       FROM finding_carryover c
       JOIN findings f ON f.id = c.previous_finding_id
       JOIN review_rounds r ON r.id = c.previous_round_id
       WHERE c.round_id = ?
       ORDER BY f.created_at ASC`,
      roundId,
    ).map(mapRow);
  },

  setVerdict(id, verdict, note) {
    run(
      `UPDATE finding_carryover SET verdict = ?, note = ?, decided_by = 'user', updated_at = ?
       WHERE id = ?`,
      verdict,
      note ?? null,
      nowIso(),
      id,
    );
    return this.byId(id);
  },
};
