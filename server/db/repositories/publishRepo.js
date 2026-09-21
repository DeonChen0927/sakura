import { all, get, run } from '../database.js';
import { newId, nowIso } from '../../lib/ids.js';

/** 发布批次状态（第 6 章）：未发布 / 发布中 / 部分成功 / 已成功 / 失败。 */
export const BatchStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PARTIAL: 'partial',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  ABORTED: 'aborted',
};

export const ItemStatus = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

const mapItem = (row) =>
  row && {
    id: row.id,
    batchId: row.batch_id,
    kind: row.kind,
    findingId: row.finding_id,
    body: row.body,
    status: row.status,
    remoteCommentId: row.remote_comment_id,
    errorMessage: row.error_message,
    dedupeKey: row.dedupe_key,
    updatedAt: row.updated_at,
  };

const mapBatch = (row) =>
  row && {
    id: row.id,
    roundId: row.round_id,
    idempotencyKey: row.idempotency_key,
    action: row.action,
    status: row.status,
    publisher: { name: row.publisher_name, id: row.publisher_id },
    inputFingerprint: row.input_fingerprint,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    failureReason: row.failure_reason,
  };

export const publishRepo = {
  findByIdempotencyKey(key) {
    return mapBatch(get('SELECT * FROM publish_batches WHERE idempotency_key = ?', key));
  },

  createBatch(batch) {
    const id = newId('batch');
    run(
      `INSERT INTO publish_batches (
         id, round_id, idempotency_key, action, status, publisher_name, publisher_id,
         input_fingerprint, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      batch.roundId,
      batch.idempotencyKey,
      batch.action,
      BatchStatus.PENDING,
      batch.publisher.name,
      batch.publisher.id ?? null,
      batch.inputFingerprint,
      nowIso(),
    );
    return this.byId(id);
  },

  byId(id) {
    return mapBatch(get('SELECT * FROM publish_batches WHERE id = ?', id));
  },

  listByRound(roundId) {
    return all(
      'SELECT * FROM publish_batches WHERE round_id = ? ORDER BY created_at DESC',
      roundId,
    ).map(mapBatch);
  },

  setStatus(id, status, failureReason = null) {
    const finished = [BatchStatus.SUCCEEDED, BatchStatus.FAILED, BatchStatus.PARTIAL, BatchStatus.ABORTED].includes(status);
    run(
      'UPDATE publish_batches SET status = ?, failure_reason = ?, finished_at = ? WHERE id = ?',
      status,
      failureReason,
      finished ? nowIso() : null,
      id,
    );
    return this.byId(id);
  },

  addItem(batchId, item) {
    const id = newId('item');
    run(
      `INSERT INTO publish_items (
         id, batch_id, kind, finding_id, body, status, dedupe_key, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      batchId,
      item.kind,
      item.findingId ?? null,
      item.body,
      ItemStatus.PENDING,
      item.dedupeKey,
      nowIso(),
    );
    return id;
  },

  items(batchId) {
    return all(
      'SELECT * FROM publish_items WHERE batch_id = ? ORDER BY rowid ASC',
      batchId,
    ).map(mapItem);
  },

  setItemResult(id, status, { remoteCommentId = null, errorMessage = null } = {}) {
    run(
      `UPDATE publish_items SET status = ?, remote_comment_id = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      status,
      remoteCommentId,
      errorMessage,
      nowIso(),
      id,
    );
  },

  succeededDedupeKeys(roundId) {
    return new Set(
      all(
        `SELECT i.dedupe_key AS key FROM publish_items i
         JOIN publish_batches b ON b.id = i.batch_id
         WHERE b.round_id = ? AND i.status = ?`,
        roundId,
        ItemStatus.SUCCEEDED,
      ).map((row) => row.key),
    );
  },

  latestByRound(roundId) {
    return mapBatch(
      get('SELECT * FROM publish_batches WHERE round_id = ? ORDER BY created_at DESC LIMIT 1', roundId),
    );
  },
};
