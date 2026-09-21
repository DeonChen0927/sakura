/**
 * Jira key 提取与验收标准核对（FR-04 / AC04）。
 * 关联来源全部可见，不任意选择其中一个 issue。
 */

const JIRA_KEY = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;
const JIRA_URL = /https?:\/\/[^\s)]+\/browse\/([A-Z][A-Z0-9]+-\d+)/gi;

export const CriterionVerdict = {
  MET: 'met',
  NOT_MET: 'not_met',
  UNVERIFIABLE: 'unverifiable',
};

function collect(text, source, into) {
  if (!text) return;
  for (const match of text.matchAll(JIRA_URL)) {
    const key = match[1].toUpperCase();
    if (!into.has(key)) into.set(key, { key, sources: [] });
    into.get(key).sources.push({ source, evidence: match[0] });
  }
  for (const match of text.matchAll(JIRA_KEY)) {
    const key = `${match[1]}-${match[2]}`.toUpperCase();
    if (!into.has(key)) into.set(key, { key, sources: [] });
    const entry = into.get(key);
    if (!entry.sources.some((item) => item.source === source)) {
      entry.sources.push({ source, evidence: match[0] });
    }
  }
}

/** 从 PR 标题、描述、分支名提取候选 key，并标明来源（FR-04）。 */
export function extractJiraKeys({ title, description, sourceBranch }, manualKeys = []) {
  const found = new Map();
  collect(title, 'title', found);
  collect(description, 'description', found);
  collect(sourceBranch?.replace(/[/_]/g, ' '), 'branch', found);
  for (const key of manualKeys) {
    const normalized = String(key).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalized)) continue;
    if (!found.has(normalized)) found.set(normalized, { key: normalized, sources: [] });
    found.get(normalized).sources.push({ source: 'manual', evidence: normalized });
  }
  return [...found.values()];
}

const REQUIRED_FIELDS = ['summary', 'status', 'issueType', 'updatedAt'];

/**
 * 校验 Jira 快照是否足以支撑本轮评审。
 * 必需字段缺失、读取失败、语义不清仍然阻断；缺少验收标准只降级为警告（产品决定）。
 */
export function validateJiraSnapshot(snapshot) {
  const blockers = [];
  const warnings = [];

  if (!snapshot || !snapshot.issues?.length) {
    blockers.push({
      code: 'jira_missing',
      message: '本 PR 没有可用的 Jira 关联需求。',
      remedy: '请在 PR 标题/描述/分支中补充 Jira key，或在启动前手工补充 issue key。',
    });
    return { ok: false, blockers, warnings };
  }

  for (const issue of snapshot.issues) {
    for (const field of REQUIRED_FIELDS) {
      if (!issue[field]) {
        blockers.push({
          code: 'jira_field_missing',
          message: `Jira ${issue.key} 缺少必需字段：${field}。`,
          remedy: '请补齐 Jira 字段或确认字段映射配置后重试。',
          subject: issue.key,
        });
      }
    }
    if (issue.error) {
      blockers.push({
        code: 'jira_read_failed',
        message: `Jira ${issue.key} 读取失败：${issue.error}`,
        remedy: '请检查 Jira 连接、权限或 issue 是否存在。',
        subject: issue.key,
      });
      continue;
    }
    if (!issue.acceptanceCriteria?.length) {
      // 产品决定：缺验收标准不阻断评审，但必须如实降级——只做代码评审，
      // 不做验收核对，AI 仍然不得自行臆造标准。
      warnings.push({
        code: 'jira_acceptance_missing',
        message: `Jira ${issue.key} 没有独立的验收标准，本轮只做代码评审，不做验收核对（AI 不得自行臆造标准）。`,
        remedy: '如需验收核对，请在 Jira 中补充验收标准后重新评审。',
        subject: issue.key,
      });
    }
    if (issue.ambiguous) {
      blockers.push({
        code: 'jira_ambiguous',
        message: `Jira ${issue.key} 的需求语义不清，本轮评审标记为不完整。`,
        remedy: '请澄清需求或补充可验证依据后重新评审。',
        subject: issue.key,
      });
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

/**
 * 校验 AI 的验收核对覆盖率：每条验收标准都必须有核对记录，
 * 静态代码无法验证的不能标为通过（FR-04 / AC04）。
 */
export function validateCriteriaCoverage(snapshot, checks = []) {
  const problems = [];
  const byId = new Map(checks.map((check) => [check.criterionId, check]));
  const needsHuman = [];

  for (const issue of snapshot.issues ?? []) {
    for (const criterion of issue.acceptanceCriteria ?? []) {
      const check = byId.get(criterion.id);
      if (!check) {
        problems.push({
          code: 'criterion_uncovered',
          message: `验收标准未被核对：${issue.key} / ${criterion.id}`,
        });
        continue;
      }
      if (!Object.values(CriterionVerdict).includes(check.verdict)) {
        problems.push({
          code: 'criterion_verdict_invalid',
          message: `验收标准核对结论非法：${issue.key} / ${criterion.id}`,
        });
        continue;
      }
      if (check.verdict === CriterionVerdict.UNVERIFIABLE) needsHuman.push(criterion.id);
      if (check.verdict !== CriterionVerdict.UNVERIFIABLE && !check.evidence?.length) {
        problems.push({
          code: 'criterion_evidence_missing',
          message: `验收标准缺少代码证据：${issue.key} / ${criterion.id}`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, needsHuman };
}

/** 需求指纹：关联关系或关键内容变化时旧报告过期（FR-04 / AC10）。 */
export function jiraFingerprintParts(snapshot) {
  return (snapshot?.issues ?? [])
    .map((issue) => `${issue.key}@${issue.updatedAt ?? 'unknown'}`)
    .sort();
}
