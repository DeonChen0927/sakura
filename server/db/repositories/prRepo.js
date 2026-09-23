import { all, get, run, parseJson } from '../database.js';
import { nowIso } from '../../lib/ids.js';

const mapRow = (row) =>
  row && {
    id: row.id,
    repository: row.repository,
    number: row.number,
    title: row.title,
    description: row.description,
    author: { name: row.author_name, id: row.author_id, accountId: row.author_account_id ?? null },
    authoredByMe: Boolean(row.authored_by_me),
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    sourceCommit: row.source_commit,
    targetCommit: row.target_commit,
    lifecycleState: row.lifecycle_state,
    isDraft: Boolean(row.is_draft),
    myReviewState: row.my_review_state,
    remoteMissing: Boolean(row.remote_missing),
    remoteMissingAt: row.remote_missing_at ?? null,
    archivedAt: row.archived_at ?? null,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
    raw: parseJson(row.raw_json, null),
  };

export const prRepo = {
  upsert(pr) {
    const id = `${pr.repository}#${pr.number}`;
    run(
      `INSERT INTO pull_requests (
         id, repository, number, title, description, author_name, author_id, author_account_id,
         authored_by_me, source_branch, target_branch, source_commit, target_commit,
         lifecycle_state, is_draft, my_review_state, updated_at, synced_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository, number) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         author_name = excluded.author_name,
         author_id = excluded.author_id,
         author_account_id = excluded.author_account_id,
         authored_by_me = excluded.authored_by_me,
         source_branch = excluded.source_branch,
         target_branch = excluded.target_branch,
         source_commit = excluded.source_commit,
         target_commit = excluded.target_commit,
         lifecycle_state = excluded.lifecycle_state,
         is_draft = excluded.is_draft,
         my_review_state = excluded.my_review_state,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         raw_json = excluded.raw_json,
         archived_at = NULL`,
      id,
      pr.repository,
      pr.number,
      pr.title,
      pr.description ?? null,
      pr.author?.name ?? null,
      pr.author?.id ?? null,
      pr.author?.accountId ?? null,
      pr.authoredByMe ? 1 : 0,
      pr.sourceBranch ?? null,
      pr.targetBranch ?? null,
      pr.sourceCommit ?? null,
      pr.targetCommit ?? null,
      pr.lifecycleState,
      pr.isDraft ? 1 : 0,
      pr.myReviewState ?? 'none',
      pr.updatedAt ?? null,
      nowIso(),
      pr.raw ? JSON.stringify(pr.raw) : null,
    );
    return this.byId(id);
  },

  byId(id) {
    return mapRow(get('SELECT * FROM pull_requests WHERE id = ?', id));
  },

  /** 同步对账用：远端仍列为待我评审时清除标记，不再列出时打标记而不是直接抹掉历史。 */
  markMissing(id, missing) {
    run(
      'UPDATE pull_requests SET remote_missing = ?, remote_missing_at = ? WHERE id = ?',
      missing ? 1 : 0,
      missing ? nowIso() : null,
      id,
    );
    return this.byId(id);
  },

  /** 没有任何本地评审痕迹的过期快照可以直接删除；有痕迹的改为归档（第 6 章历史可查）。 */
  remove(id) {
    run('DELETE FROM pull_requests WHERE id = ?', id);
  },

  /**
   * 归档：远端不再列为待我评审的 PR 退出工作台列表，但行还在，
   * 评审历史仍能查到它的报告。远端重新列出时由 upsert 自动取消归档。
   */
  archive(id, archived) {
    run(
      'UPDATE pull_requests SET archived_at = ? WHERE id = ?',
      archived ? nowIso() : null,
      id,
    );
    return this.byId(id);
  },

  /** 工作台列表：归档的 PR 不再出现。 */
  list(repository) {
    return all(
      'SELECT * FROM pull_requests WHERE repository = ? AND archived_at IS NULL ORDER BY updated_at DESC',
      repository,
    ).map(mapRow);
  },

  /** 含归档行，供同步对账与历史视图使用。 */
  listAll(repository) {
    return all(
      'SELECT * FROM pull_requests WHERE repository = ? ORDER BY updated_at DESC',
      repository,
    ).map(mapRow);
  },

  lastSyncedAt(repository) {
    const row = get(
      'SELECT MAX(synced_at) AS synced FROM pull_requests WHERE repository = ?',
      repository,
    );
    return row?.synced ?? null;
  },
};
