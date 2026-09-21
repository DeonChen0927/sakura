import { all, get, run, parseJson } from '../database.js';
import { newId, nowIso } from '../../lib/ids.js';

/** 本地评审轮次状态（第 6 章 状态模型），不完整/失败/取消/过期都不属于“通过”。 */
export const RoundStatus = {
  PENDING: 'pending',
  PREFLIGHT: 'preflight',
  RUNNING: 'running',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  // 远端已经由你本人表态（Approved / Changes requested），本地轮次自动结束：
  // 这不是“你在 Sakura 里确认过”，报告仍可查看与发布，只是不再占用待办。
  CLOSED_REMOTE: 'closed_remote',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

export const PUBLISHABLE_STATUSES = new Set([
  RoundStatus.AWAITING_CONFIRMATION,
  RoundStatus.CLOSED_REMOTE,
]);

/** 评审历史最多保留 100 轮，更旧的直接删除（用户决定）。 */
export const HISTORY_LIMIT = 100;

const mapRound = (row) =>
  row && {
    id: row.id,
    pullRequestId: row.pull_request_id,
    roundNumber: row.round_number,
    status: row.status,
    statusReason: row.status_reason,
    model: { id: row.model_id, name: row.model_name, verified: Boolean(row.model_verified) },
    sessionId: row.session_id,
    sourceCommit: row.source_commit,
    targetCommit: row.target_commit,
    inputFingerprint: row.input_fingerprint,
    scope: parseJson(row.scope_json, null),
    jiraSnapshot: parseJson(row.jira_snapshot_json, null),
    aiResult: parseJson(row.ai_result_json, null),
    summaryZh: row.summary_zh,
    summaryEnDraft: row.summary_en_draft,
    integrationMode: row.integration_mode,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };

const mapFinding = (row) =>
  row && {
    id: row.id,
    roundId: row.round_id,
    key: row.finding_key,
    severity: row.severity,
    titleZh: row.title_zh,
    detailZh: row.detail_zh,
    evidence: parseJson(row.evidence_json, []),
    filePath: row.file_path,
    oldLine: row.old_line,
    newLine: row.new_line,
    anchorKind: row.anchor_kind,
    aiCommentEn: row.comment_en,
    inScope: Boolean(row.in_scope),
    createdAt: row.created_at,
    revision: row.rev_updated_at
      ? {
          commentEn: row.rev_comment_en,
          selected: Boolean(row.rev_selected),
          deleted: Boolean(row.rev_deleted),
          updatedAt: row.rev_updated_at,
        }
      : null,
  };

export const roundRepo = {
  nextRoundNumber(pullRequestId) {
    const row = get(
      'SELECT MAX(round_number) AS max FROM review_rounds WHERE pull_request_id = ?',
      pullRequestId,
    );
    return (row?.max ?? 0) + 1;
  },

  create(round) {
    const id = newId('round');
    run(
      `INSERT INTO review_rounds (
         id, pull_request_id, round_number, status, model_id, model_name, model_verified,
         session_id, source_commit, target_commit, input_fingerprint, scope_json,
         jira_snapshot_json, integration_mode, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      round.pullRequestId,
      round.roundNumber,
      round.status ?? RoundStatus.PREFLIGHT,
      round.model.id,
      round.model.name,
      0,
      round.sessionId ?? null,
      round.sourceCommit,
      round.targetCommit,
      round.inputFingerprint,
      round.scope ? JSON.stringify(round.scope) : null,
      round.jiraSnapshot ? JSON.stringify(round.jiraSnapshot) : null,
      round.integrationMode,
      nowIso(),
    );
    return this.byId(id);
  },

  byId(id) {
    return mapRound(get('SELECT * FROM review_rounds WHERE id = ?', id));
  },

  listByPr(pullRequestId) {
    return all(
      'SELECT * FROM review_rounds WHERE pull_request_id = ? ORDER BY round_number DESC',
      pullRequestId,
    ).map(mapRound);
  },

  latestByPr(pullRequestId) {
    return mapRound(
      get(
        'SELECT * FROM review_rounds WHERE pull_request_id = ? ORDER BY round_number DESC LIMIT 1',
        pullRequestId,
      ),
    );
  },

  listAll(limit = HISTORY_LIMIT) {
    return all(
      `SELECT r.*, p.number AS pr_number, p.title AS pr_title, p.repository AS pr_repository
       FROM review_rounds r JOIN pull_requests p ON p.id = r.pull_request_id
       ORDER BY r.started_at DESC LIMIT ?`,
      limit,
    ).map((row) => ({
      ...mapRound(row),
      pullRequest: { number: row.pr_number, title: row.pr_title, repository: row.pr_repository },
    }));
  },

  /**
   * 历史只保留最近 HISTORY_LIMIT 轮，超出的直接删除（级联清掉事件、发现、发布记录）。
   * 正在跑的轮次永远不删。返回实际删除条数。
   */
  pruneHistory(limit = HISTORY_LIMIT) {
    const stale = all(
      `SELECT id FROM review_rounds
       WHERE status NOT IN (?, ?)
       ORDER BY started_at DESC
       LIMIT -1 OFFSET ?`,
      RoundStatus.PREFLIGHT,
      RoundStatus.RUNNING,
      limit,
    );
    for (const row of stale) run('DELETE FROM review_rounds WHERE id = ?', row.id);
    return stale.length;
  },

  listActive() {
    return all(
      `SELECT * FROM review_rounds WHERE status IN (?, ?) ORDER BY started_at ASC`,
      RoundStatus.PREFLIGHT,
      RoundStatus.RUNNING,
    ).map(mapRound);
  },

  activeCount() {
    const row = get(
      `SELECT COUNT(*) AS count FROM review_rounds WHERE status IN (?, ?)`,
      RoundStatus.PREFLIGHT,
      RoundStatus.RUNNING,
    );
    return row?.count ?? 0;
  },

  hasActiveForPr(pullRequestId) {
    const row = get(
      `SELECT COUNT(*) AS count FROM review_rounds
       WHERE pull_request_id = ? AND status IN (?, ?)`,
      pullRequestId,
      RoundStatus.PREFLIGHT,
      RoundStatus.RUNNING,
    );
    return (row?.count ?? 0) > 0;
  },

  updateStatus(id, status, reason = null) {
    const finished = [
      RoundStatus.CANCELLED,
      RoundStatus.FAILED,
      RoundStatus.AWAITING_CONFIRMATION,
      RoundStatus.CLOSED_REMOTE,
    ].includes(status);
    run(
      `UPDATE review_rounds SET status = ?, status_reason = ?, finished_at = COALESCE(finished_at, ?)
       WHERE id = ?`,
      status,
      reason,
      finished ? nowIso() : null,
      id,
    );
    return this.byId(id);
  },

  markExpired(id, reason) {
    run('UPDATE review_rounds SET status = ?, status_reason = ? WHERE id = ?', RoundStatus.EXPIRED, reason, id);
    return this.byId(id);
  },

  attachSession(id, sessionId) {
    run('UPDATE review_rounds SET session_id = ? WHERE id = ?', sessionId, id);
  },

  markModelVerified(id, verified) {
    run('UPDATE review_rounds SET model_verified = ? WHERE id = ?', verified ? 1 : 0, id);
  },

  saveScope(id, scope) {
    run('UPDATE review_rounds SET scope_json = ? WHERE id = ?', JSON.stringify(scope), id);
  },

  saveJiraSnapshot(id, snapshot) {
    run('UPDATE review_rounds SET jira_snapshot_json = ? WHERE id = ?', JSON.stringify(snapshot), id);
  },

  saveAiResult(id, result) {
    run(
      `UPDATE review_rounds SET ai_result_json = ?, summary_zh = ?, summary_en_draft = ? WHERE id = ?`,
      JSON.stringify(result),
      result.summaryZh ?? null,
      result.summaryEn ?? null,
      id,
    );
  },

  addEvent(roundId, stage, message, level = 'info') {
    run(
      'INSERT INTO round_events (id, round_id, stage, message, level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('evt'),
      roundId,
      stage,
      message,
      level,
      nowIso(),
    );
  },

  events(roundId) {
    return all(
      'SELECT * FROM round_events WHERE round_id = ? ORDER BY created_at ASC',
      roundId,
    ).map((row) => ({
      id: row.id,
      stage: row.stage,
      message: row.message,
      level: row.level,
      createdAt: row.created_at,
    }));
  },

  insertFinding(roundId, finding) {
    const id = newId('find');
    run(
      `INSERT INTO findings (
         id, round_id, finding_key, severity, title_zh, detail_zh, evidence_json,
         file_path, old_line, new_line, anchor_kind, comment_en, in_scope, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      roundId,
      finding.key,
      finding.severity,
      finding.titleZh,
      finding.detailZh,
      JSON.stringify(finding.evidence ?? []),
      finding.filePath ?? null,
      finding.oldLine ?? null,
      finding.newLine ?? null,
      finding.anchorKind ?? 'line',
      finding.commentEn,
      finding.inScope === false ? 0 : 1,
      nowIso(),
    );
    return id;
  },

  findings(roundId) {
    return all(
      `SELECT f.*, r.comment_en AS rev_comment_en, r.selected AS rev_selected,
              r.deleted AS rev_deleted, r.updated_at AS rev_updated_at
       FROM findings f LEFT JOIN finding_revisions r ON r.finding_id = f.id
       WHERE f.round_id = ? ORDER BY f.created_at ASC`,
      roundId,
    ).map(mapFinding);
  },

  findingById(id) {
    return mapFinding(
      get(
        `SELECT f.*, r.comment_en AS rev_comment_en, r.selected AS rev_selected,
                r.deleted AS rev_deleted, r.updated_at AS rev_updated_at
         FROM findings f LEFT JOIN finding_revisions r ON r.finding_id = f.id
         WHERE f.id = ?`,
        id,
      ),
    );
  },

  /** 人工修订独立存储，不覆盖 AI 原始结果（FR-06 / AC18）。 */
  saveFindingRevision(findingId, patch) {
    const current = get('SELECT * FROM finding_revisions WHERE finding_id = ?', findingId);
    const next = {
      commentEn: patch.commentEn !== undefined ? patch.commentEn : current?.comment_en ?? null,
      selected:
        patch.selected !== undefined ? patch.selected : current ? Boolean(current.selected) : true,
      deleted: patch.deleted !== undefined ? patch.deleted : current ? Boolean(current.deleted) : false,
    };
    run(
      `INSERT INTO finding_revisions (finding_id, comment_en, selected, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(finding_id) DO UPDATE SET
         comment_en = excluded.comment_en,
         selected = excluded.selected,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at`,
      findingId,
      next.commentEn,
      next.selected ? 1 : 0,
      next.deleted ? 1 : 0,
      nowIso(),
    );
    return this.findingById(findingId);
  },

  summaryRevision(roundId) {
    const row = get('SELECT * FROM round_summary_revisions WHERE round_id = ?', roundId);
    return row
      ? {
          summaryEn: row.summary_en,
          overrideReasonEn: row.override_reason_en,
          updatedAt: row.updated_at,
        }
      : null;
  },

  saveSummaryRevision(roundId, patch) {
    const current = get('SELECT * FROM round_summary_revisions WHERE round_id = ?', roundId);
    const summaryEn = patch.summaryEn !== undefined ? patch.summaryEn : current?.summary_en ?? null;
    const overrideReasonEn =
      patch.overrideReasonEn !== undefined
        ? patch.overrideReasonEn
        : current?.override_reason_en ?? null;
    run(
      `INSERT INTO round_summary_revisions (round_id, summary_en, override_reason_en, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(round_id) DO UPDATE SET
         summary_en = excluded.summary_en,
         override_reason_en = excluded.override_reason_en,
         updated_at = excluded.updated_at`,
      roundId,
      summaryEn,
      overrideReasonEn,
      nowIso(),
    );
    return this.summaryRevision(roundId);
  },
};
