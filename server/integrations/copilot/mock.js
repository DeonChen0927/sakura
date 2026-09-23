import { setTimeout as delay } from 'node:timers/promises';
import { AppError, ErrorKind } from '../../lib/errors.js';
import { CriterionVerdict } from '../../domain/jira.js';
import { Severity, SuggestedAction } from '../../domain/reviewSchema.js';

const MOCK_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
];

const STAGES = [
  { stage: 'prepare_code', message: '准备范围内代码与只读上下文', ms: 700 },
  { stage: 'read_requirements', message: '读取 Jira 需求与验收标准快照', ms: 600 },
  { stage: 'analyze', message: '分析范围内变更', ms: 1200 },
  { stage: 'compose_report', message: '整理中文报告与英文评论草稿', ms: 700 },
];

/** 从范围内 diff 中取一条新增行，作为可定位的证据锚点。 */
function pickAnchor(files, filePath) {
  const file = files.find((item) => item.path === filePath);
  for (const hunk of file?.hunks ?? []) {
    const added = hunk.lines.find((line) => line.type === 'added');
    if (added) return { filePath, newLine: added.newLine, content: added.content.trim() };
  }
  return { filePath, newLine: null, content: '' };
}

/**
 * Copilot 演示适配器：不调用真实 CLI，不产生真实分析。
 * 输出结构与正式适配器一致，便于后端校验、署名与发布流程端到端联调。
 */
export function createMockCopilotClient() {
  return {
    mode: 'mock',

    modelSource: { enumerable: true, note: '演示模式：内置模型列表，未调用本机 Copilot CLI。' },

    async getIdentity() {
      return { loggedIn: true, account: 'demo-local-user', tokenSource: 'demo', demo: true };
    },

    async checkAuth() {
      return { ok: true, tokenSource: 'demo', detail: '演示模式：未调用本机 Copilot CLI。' };
    },

    async listModels() {
      return MOCK_MODELS.map((model) => ({ ...model, available: true, demo: true }));
    },

    async verifyModel(modelId) {
      const known = MOCK_MODELS.some((item) => item.id === modelId);
      return {
        id: modelId,
        status: known ? 'available' : 'unavailable',
        detail: '演示模式：未调用本机 Copilot CLI。',
      };
    },

    async testConnection() {
      return {
        ok: true,
        demo: true,
        detail: '演示模式：未调用本机 Copilot CLI，模型可用性未经真实校验。',
      };
    },

    async runReview({ model, payload, signal, onEvent }) {
      if (!MOCK_MODELS.some((item) => item.id === model.id)) {
        throw new AppError(ErrorKind.PRECONDITION, `所选模型不可用：${model.id}`, {
          remedy: '请在连接设置中选择一个可用模型；系统不会自动改用其他模型。',
        });
      }

      const sessionId = `mock-session-${Date.now().toString(36)}`;
      onEvent?.({ stage: 'session_created', message: `已创建演示 session ${sessionId}` });

      for (const item of STAGES) {
        if (signal?.aborted) throw new AppError(ErrorKind.CONFLICT, '评审已取消');
        onEvent?.({ stage: item.stage, message: item.message });
        await delay(item.ms);
      }
      if (signal?.aborted) throw new AppError(ErrorKind.CONFLICT, '评审已取消');

      const inScopeFiles = payload.scope.inScopeFiles;
      const anchors = inScopeFiles.map((path) => pickAnchor(payload.diffFiles, path));
      const primary = anchors.find((anchor) => anchor.newLine) ?? anchors[0];

      const findings = [];
      if (primary?.newLine) {
        findings.push({
          key: 'cache-visibility',
          severity: Severity.BLOCKING,
          titleZh: '缓存写入缺少并发可见性保证',
          detailZh:
            '范围内新增的缓存写入使用非线程安全的 HashMap，而视口切换可能来自不同线程，存在读到过期或不完整数据的风险。',
          evidence: [
            {
              filePath: primary.filePath,
              newLine: primary.newLine,
              snippet: primary.content,
              note: '范围内新增行',
            },
          ],
          filePath: primary.filePath,
          newLine: primary.newLine,
          oldLine: null,
          anchorKind: 'line',
          commentEn:
            'This cache is written from viewport switches that can originate on different threads, but the backing map is not thread-safe. Please use a concurrent map or guard the read/write pair explicitly.',
        });
      }
      const second = anchors.find((anchor) => anchor !== primary && anchor.newLine);
      if (second) {
        findings.push({
          key: 'cache-eviction-missing',
          severity: Severity.IMPORTANT,
          titleZh: '未见缓存清理逻辑',
          detailZh: '范围内变更新增了缓存写入，但没有在关闭 study 时清理对应条目，可能造成内存增长与陈旧数据。',
          evidence: [
            {
              filePath: second.filePath,
              newLine: second.newLine,
              snippet: second.content,
              note: '范围内新增行',
            },
          ],
          filePath: second.filePath,
          newLine: second.newLine,
          oldLine: null,
          anchorKind: 'line',
          commentEn:
            'The new cache entries are never evicted when a study is closed. Please add eviction so stale annotations cannot be served after a study switch.',
        });
      }

      const criteriaChecks = [];
      for (const issue of payload.jiraSnapshot.issues) {
        issue.acceptanceCriteria.forEach((criterion, index) => {
          const verdict =
            index === 0
              ? CriterionVerdict.MET
              : index === 1
                ? CriterionVerdict.NOT_MET
                : CriterionVerdict.UNVERIFIABLE;
          criteriaChecks.push({
            criterionId: criterion.id,
            issueKey: issue.key,
            verdict,
            noteZh:
              verdict === CriterionVerdict.MET
                ? '范围内变更增加了视口级缓存命中路径，静态可见。'
                : verdict === CriterionVerdict.NOT_MET
                  ? '范围内变更没有实现关闭 study 时的缓存清理。'
                  : '静态代码无法验证多线程实际行为，需要人工或运行时验证。',
            evidence:
              verdict === CriterionVerdict.UNVERIFIABLE
                ? []
                : [{ filePath: primary?.filePath ?? null, newLine: primary?.newLine ?? null }],
          });
        });
      }

      const result = {
        summaryZh: `本轮评审覆盖 Team Seal 范围内 ${inScopeFiles.length} 个文件，发现 ${findings.length} 条问题；另有需人工验证的验收标准。以上为演示数据，不是真实分析结论。`,
        summaryEn:
          'Reviewed the Team Seal scope of this pull request. Two issues need attention before approval: thread-safety of the new cache and missing eviction on study close.',
        suggestedAction: findings.some((item) => item.severity === Severity.BLOCKING)
          ? SuggestedAction.REQUEST_CHANGES
          : SuggestedAction.COMMENT_ONLY,
        scopeCoverage: {
          reviewedFiles: inScopeFiles,
          contextFiles: payload.scope.outOfScopeFiles ?? [],
          notCovered: [],
        },
        criteriaChecks,
        // 演示模式不接触真实 wiki：如实写明未检索，不伪造知识库引用（FR-12 / AC21）。
        wikiConsulted: {
          queried: false,
          queries: [],
          references: [],
          noteZh: '演示模式未调用 ei-llm-wiki 知识库，本结果不含任何 wiki 依据。',
        },
        uncertainties: [
          '缓存在多线程视口切换下的实际行为无法通过静态代码确认，需要人工或集成测试验证。',
        ],
        findings,
      };

      onEvent?.({ stage: 'completed', message: '演示结果已生成（非真实分析）' });
      return { sessionId, modelUsed: model.id, result, exitCode: 0, demo: true };
    },
  };
}
