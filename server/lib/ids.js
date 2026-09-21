import { createHash, randomUUID } from 'node:crypto';

export const newId = (prefix) => (prefix ? `${prefix}_${randomUUID()}` : randomUUID());

export const nowIso = () => new Date().toISOString();

/**
 * 输入指纹：用于冻结本轮评审输入并在发布前检测过期（FR-05 / FR-07 / AC10）。
 */
export function fingerprint(parts) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts, Object.keys(parts).sort()));
  return hash.digest('hex').slice(0, 32);
}

/** 发布批次去重标识：相同批次重试不得重复写入远端（FR-07 / AC11）。 */
export function idempotencyKey(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}
