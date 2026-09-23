import { isPathInScope } from './teamSeal.js';
import { CriterionVerdict, validateCriteriaCoverage } from './jira.js';
import { validateWikiUsage, validateFindingWikiRefs, normalizeWikiPath } from './knowledgeBase.js';

/**
 * AI 结构化结果的后端校验（FR-05 / AC06）。
 * 退出码异常、超时、截断、格式不符、缺少覆盖或字段，都不能转成“通过”。
 */

export const Severity = {
  BLOCKING: 'blocking',
  IMPORTANT: 'important',
  SUGGESTION: 'suggestion',
};

export const SuggestedAction = {
  REQUEST_CHANGES: 'request_changes',
  APPROVE: 'approve',
  COMMENT_ONLY: 'comment_only',
};

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateAiResult(raw, { scope, jiraSnapshot, knowledgeBase } = {}) {
  const problems = [];
  const push = (code, message) => problems.push({ code, message });

  if (!raw || typeof raw !== 'object') {
    return { ok: false, problems: [{ code: 'result_not_object', message: 'AI 输出不是合法的结构化对象' }] };
  }

  if (!isNonEmptyString(raw.summaryZh)) push('summary_zh_missing', '缺少中文摘要');
  if (!isNonEmptyString(raw.summaryEn)) push('summary_en_missing', '缺少英文发布草稿总结');
  if (!Object.values(SuggestedAction).includes(raw.suggestedAction)) {
    push('suggested_action_invalid', 'AI 建议动作非法');
  }

  const coverage = raw.scopeCoverage;
  if (!coverage || !Array.isArray(coverage.reviewedFiles)) {
    push('coverage_missing', '缺少范围覆盖信息，无法判断是否完整评审');
  } else {
    const missing = (scope?.inScopeFiles ?? []).filter(
      (file) => !coverage.reviewedFiles.some((item) => item.toLowerCase() === file.toLowerCase()),
    );
    if (missing.length) {
      push('coverage_incomplete', `范围内文件未被评审：${missing.join('、')}`);
    }
  }

  if (!Array.isArray(raw.uncertainties)) push('uncertainties_missing', '缺少不确定项列表');

  // 知识库（FR-12 / AC26）：要求使用 ei-llm-wiki 时，必须给出可核对的检索与引用。
  // 引用路径由后端对着真实 checkout 核对，模型无法靠自述蒙混过关。
  const wikiActive = Boolean(knowledgeBase?.active);
  if (wikiActive) {
    const wiki = validateWikiUsage(raw.wikiConsulted, { hasFile: knowledgeBase.hasFile });
    wiki.problems.forEach((problem) => problems.push(problem));
  }

  if (!Array.isArray(raw.criteriaChecks)) {
    push('criteria_checks_missing', '缺少 Jira 验收标准核对记录');
  } else {
    const result = validateCriteriaCoverage(jiraSnapshot, raw.criteriaChecks);
    result.problems.forEach((problem) => problems.push(problem));
  }

  if (!Array.isArray(raw.findings)) {
    push('findings_missing', '缺少发现列表');
    return { ok: false, problems };
  }

  const keys = new Set();
  raw.findings.forEach((finding, index) => {
    const label = finding?.key ?? `#${index + 1}`;
    if (!isNonEmptyString(finding?.key)) push('finding_key_missing', `发现 ${label} 缺少稳定 ID`);
    else if (keys.has(finding.key)) push('finding_key_duplicate', `发现 ID 重复：${finding.key}`);
    else keys.add(finding.key);

    if (!Object.values(Severity).includes(finding?.severity)) {
      push('finding_severity_invalid', `发现 ${label} 的严重程度非法`);
    }
    if (!isNonEmptyString(finding?.titleZh)) push('finding_title_missing', `发现 ${label} 缺少中文标题`);
    if (!isNonEmptyString(finding?.detailZh)) push('finding_detail_missing', `发现 ${label} 缺少中文说明`);
    if (!isNonEmptyString(finding?.commentEn)) push('finding_comment_missing', `发现 ${label} 缺少英文评论`);

    const anchorKind = finding?.anchorKind ?? 'line';
    if (anchorKind === 'line') {
      if (!isNonEmptyString(finding?.filePath)) {
        push('finding_path_missing', `发现 ${label} 缺少文件路径`);
      } else if (!isPathInScope(scope, finding.filePath)) {
        // 正式发现必须归属评审范围内的变更（FR-03 / AC03）
        push('finding_out_of_scope', `发现 ${label} 落在 Team Seal 范围之外：${finding.filePath}`);
      }
      const hasLine = Number.isInteger(finding?.newLine) || Number.isInteger(finding?.oldLine);
      if (!hasLine) push('finding_line_missing', `发现 ${label} 缺少合法的新旧侧行号`);
    } else if (anchorKind === 'pr') {
      if (!isNonEmptyString(finding?.scopeJustification)) {
        push('finding_scope_justification_missing', `PR 级发现 ${label} 必须说明其范围归属`);
      }
    } else {
      push('finding_anchor_invalid', `发现 ${label} 的锚点类型非法`);
    }

    if (!Array.isArray(finding?.evidence) || !finding.evidence.length) {
      push('finding_evidence_missing', `发现 ${label} 缺少证据`);
    }

    if (wikiActive) {
      const refs = validateFindingWikiRefs(finding?.wikiRefs, { hasFile: knowledgeBase.hasFile });
      refs.problems.forEach((problem) =>
        push(problem.code, `发现 ${label} 的 ${problem.message}`),
      );
    }
  });

  return { ok: problems.length === 0, problems };
}

/** 归一化为持久化结构，字段缺失在校验阶段已阻断。 */
export function normalizeAiResult(raw) {
  return {
    summaryZh: raw.summaryZh,
    summaryEn: raw.summaryEn,
    suggestedAction: raw.suggestedAction,
    scopeCoverage: {
      reviewedFiles: raw.scopeCoverage?.reviewedFiles ?? [],
      contextFiles: raw.scopeCoverage?.contextFiles ?? [],
      notCovered: raw.scopeCoverage?.notCovered ?? [],
    },
    // 知识库检索记录随报告一起保存：历史回放要能看出本轮到底查了什么（FR-12）。
    wikiConsulted: {
      queried: raw.wikiConsulted?.queried === true,
      queries: (raw.wikiConsulted?.queries ?? []).map((item) => String(item)),
      references: (raw.wikiConsulted?.references ?? [])
        .map((ref) => ({
          path: normalizeWikiPath(ref?.path),
          titleZh: String(ref?.titleZh ?? '').trim(),
          noteZh: String(ref?.noteZh ?? '').trim(),
        }))
        .filter((ref) => ref.path),
      noteZh: String(raw.wikiConsulted?.noteZh ?? '').trim(),
    },
    criteriaChecks: (raw.criteriaChecks ?? []).map((check) => ({
      criterionId: check.criterionId,
      issueKey: check.issueKey ?? null,
      verdict: check.verdict,
      noteZh: check.noteZh ?? '',
      evidence: check.evidence ?? [],
      needsHumanVerification: check.verdict === CriterionVerdict.UNVERIFIABLE,
    })),
    uncertainties: raw.uncertainties ?? [],
    findings: (raw.findings ?? []).map((finding) => ({
      key: finding.key,
      severity: finding.severity,
      titleZh: finding.titleZh,
      detailZh: finding.detailZh,
      evidence: finding.evidence ?? [],
      filePath: finding.filePath ?? null,
      oldLine: Number.isInteger(finding.oldLine) ? finding.oldLine : null,
      newLine: Number.isInteger(finding.newLine) ? finding.newLine : null,
      anchorKind: finding.anchorKind ?? 'line',
      scopeJustification: finding.scopeJustification ?? null,
      wikiRefs: (Array.isArray(finding.wikiRefs) ? finding.wikiRefs : [])
        .map((item) => normalizeWikiPath(typeof item === 'string' ? item : item?.path))
        .filter(Boolean),
      commentEn: finding.commentEn,
      inScope: true,
    })),
  };
}
