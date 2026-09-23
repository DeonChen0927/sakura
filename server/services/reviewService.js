import { getClients } from '../integrations/registry.js';
import { prService } from './prService.js';
import { settingsService } from './settingsService.js';
import { gitCacheService } from './gitCacheService.js';
import { knowledgeBaseService } from './knowledgeBaseService.js';
import { roundRepo, RoundStatus, HISTORY_LIMIT } from '../db/repositories/roundRepo.js';
import { prRepo } from '../db/repositories/prRepo.js';
import { publishRepo } from '../db/repositories/publishRepo.js';
import { auditRepo } from '../db/repositories/auditRepo.js';
import { carryoverRepo, CarryoverVerdict } from '../db/repositories/carryoverRepo.js';
import { validateAiResult, normalizeAiResult } from '../domain/reviewSchema.js';
import { jiraFingerprintParts } from '../domain/jira.js';
import { filterDiffByPaths } from '../domain/diff.js';
import { buildChineseAttribution, buildEnglishSignature, SignatureContext, stripSignature } from '../domain/signature.js';
import { AppError, ErrorKind, notFound, preconditionError, validationError } from '../lib/errors.js';
import { fingerprint } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

/** 运行中的轮次：同一 PR 同时只允许一轮，全局串行执行（FR-08）。 */
const running = new Map();
let queue = Promise.resolve();

export const reviewService = {
  /**
   * 进程重启后没有任何运行中的子进程会被恢复，数据库里遗留的 preflight/running
   * 轮次一定已经中断。启动时如实标记为已取消，避免 PR 列表永远停在「运行中」。
   */
  reconcileOrphanRounds() {
    const orphans = roundRepo.listActive().filter((round) => !running.has(round.id));
    for (const round of orphans) {
      roundRepo.addEvent(round.id, RoundStatus.CANCELLED, '服务重启，本轮已中断', 'error');
      roundRepo.updateStatus(round.id, RoundStatus.CANCELLED, '服务重启，本轮已中断，请重新开始评审');
      auditRepo.record('system', 'review.orphan_cancelled', round.id, {});
    }
    if (orphans.length) logger.info(`已清理 ${orphans.length} 个被服务重启中断的评审轮次`);
    return orphans.length;
  },

  /** 历史上限 100 轮，超出的旧轮次直接删除（含其事件、发现与发布记录）。 */
  pruneHistory() {
    const removed = roundRepo.pruneHistory();
    if (removed) {
      auditRepo.record('system', 'review.history_pruned', 'history', { removed, limit: HISTORY_LIMIT });
      logger.info(`评审历史超出 ${HISTORY_LIMIT} 条上限，已删除 ${removed} 轮旧记录`);
    }
    return removed;
  },

  async start(prId, { manualJiraKeys = [] } = {}) {
    const preflight = await prService.preflight(prId, { manualJiraKeys });
    if (!preflight.canStart) {
      throw preconditionError('启动前检查未通过，已阻止评审', {
        details: { blockers: preflight.blockers },
      });
    }
    if (preflight.model.invalid || !preflight.model.id) {
      throw preconditionError('评审模型配置不可用，已阻止评审');
    }

    const round = roundRepo.create({
      pullRequestId: preflight.pullRequest.id,
      roundNumber: roundRepo.nextRoundNumber(preflight.pullRequest.id),
      status: RoundStatus.PREFLIGHT,
      // 任务创建时冻结模型；之后修改全局配置不影响本轮（FR-11 / AC24）
      model: { id: preflight.model.id, name: preflight.model.name },
      sourceCommit: preflight.pullRequest.sourceCommit,
      targetCommit: preflight.pullRequest.targetCommit,
      inputFingerprint: preflight.inputFingerprint,
      scope: preflight.scope,
      jiraSnapshot: preflight.jiraSnapshot,
      // 知识库版本同样在创建时冻结：报告结论依据的是这一版 wiki，不是之后更新的内容（FR-12）
      knowledgeBase: knowledgeBaseService.snapshot(preflight.knowledgeBase),
      integrationMode: settingsService.integrationMode(),
    });

    roundRepo.addEvent(round.id, 'preflight', '前置检查通过，已冻结本轮输入快照');
    if (round.knowledgeBase?.active) {
      roundRepo.addEvent(
        round.id,
        'knowledge_base',
        `知识库已冻结：ei-llm-wiki ${round.knowledgeBase.wikiPath}${
          round.knowledgeBase.commit ? `@${String(round.knowledgeBase.commit).slice(0, 12)}` : ''
        }`,
      );
    } else {
      roundRepo.addEvent(
        round.id,
        'knowledge_base',
        '本轮没有可用的 EI wiki 知识库，评审只依据代码与需求',
        'warn',
      );
    }
    this.pruneHistory();
    auditRepo.record('user', 'review.start', round.id, {
      pr: preflight.pullRequest.number,
      model: round.model.id,
      mode: round.integrationMode,
    });

    const controller = new AbortController();
    running.set(round.id, controller);

    queue = queue.then(() =>
      this.execute(round.id, preflight, controller).catch((error) => {
        logger.error(`评审轮次执行失败 ${round.id}`, { message: error.message });
      }),
    );

    return this.detail(round.id);
  },

  async execute(roundId, preflight, controller) {
    const clients = getClients();
    const round = roundRepo.byId(roundId);
    if (!round) return;
    if (controller.signal.aborted) {
      roundRepo.updateStatus(roundId, RoundStatus.CANCELLED, '任务在开始前被取消');
      running.delete(roundId);
      return;
    }

    roundRepo.updateStatus(roundId, RoundStatus.RUNNING);
    roundRepo.addEvent(roundId, 'running', '开始调用 Copilot 评审');

    try {
      const scopedDiff = filterDiffByPaths(preflight.diff.files, preflight.scope.inScopeFiles);
      const contextFiles = await this.collectContextFiles(preflight);
      const payload = {
        pullRequest: preflight.pullRequest,
        scope: preflight.scope,
        jiraSnapshot: preflight.jiraSnapshot,
        diffFiles: scopedDiff,
        contextFiles,
        knowledgeBase: round.knowledgeBase,
      };

      const run = await clients.copilot.runReview({
        model: round.model,
        payload,
        signal: controller.signal,
        onEvent: (event) =>
          roundRepo.addEvent(roundId, event.stage, event.message, event.level ?? 'info'),
      });

      if (controller.signal.aborted) {
        roundRepo.updateStatus(roundId, RoundStatus.CANCELLED, '用户取消了本轮评审');
        return;
      }

      if (run.sessionId) roundRepo.attachSession(roundId, run.sessionId);

      // 运行时校验实际使用的模型，不一致则阻断（FR-11）
      if (run.modelUsed && run.modelUsed !== round.model.id) {
        throw preconditionError('实际使用模型与本轮冻结模型不一致，本轮结果不可用', {
          details: { expected: round.model.id, actual: run.modelUsed },
        });
      }
      roundRepo.markModelVerified(roundId, true);

      const validation = validateAiResult(run.result, {
        scope: preflight.scope,
        jiraSnapshot: preflight.jiraSnapshot,
        // 引用核对对着本轮冻结的 checkout 做：编造的 wiki 路径不能变成“有依据”的结论。
        knowledgeBase: round.knowledgeBase?.active
          ? {
              active: true,
              hasFile: (relativePath) =>
                knowledgeBaseService.hasFile(round.knowledgeBase.wikiPath, relativePath),
            }
          : { active: false },
      });
      if (!validation.ok) {
        throw new AppError(ErrorKind.UPSTREAM, 'AI 结果校验未通过，本轮报告不完整', {
          details: { problems: validation.problems },
        });
      }

      const normalized = normalizeAiResult(run.result);
      roundRepo.saveAiResult(roundId, normalized);
      for (const finding of normalized.findings) {
        roundRepo.insertFinding(roundId, finding);
      }

      if (round.knowledgeBase?.active) {
        const refs = normalized.wikiConsulted?.references ?? [];
        roundRepo.addEvent(
          roundId,
          'knowledge_base',
          refs.length
            ? `知识库引用已逐条核对通过，共 ${refs.length} 篇：${refs.map((ref) => ref.path).join('、')}`
            : `已检索知识库但没有命中相关页面：${normalized.wikiConsulted?.noteZh ?? '（无说明）'}`,
          refs.length ? 'info' : 'warn',
        );
      }

      roundRepo.addEvent(roundId, 'completed', `结果已通过后端校验，共 ${normalized.findings.length} 条发现`);
      this.buildCarryover(roundId);
      roundRepo.updateStatus(roundId, RoundStatus.AWAITING_CONFIRMATION, '待你确认');
      auditRepo.record('system', 'review.completed', roundId, {
        findings: normalized.findings.length,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.kind === ErrorKind.CONFLICT;
      const status = cancelled ? RoundStatus.CANCELLED : RoundStatus.FAILED;
      roundRepo.addEvent(roundId, status, error.message, 'error');
      roundRepo.updateStatus(roundId, status, error.message);
      auditRepo.record('system', `review.${status}`, roundId, { message: error.message });
    } finally {
      running.delete(roundId);
    }
  },

  /**
   * 只读上下文：从本机已有克隆或独立 Git 缓存取范围内文件的完整内容。
   * 不可用时返回空集合并记录事件，不用臆测内容填充（FR-03 / D06）。
   */
  async collectContextFiles(preflight) {
    if (!preflight.gitCache?.available) return [];
    const limit = gitCacheService.settings().maxContextFiles ?? 8;
    const wanted = preflight.scope.inScopeFiles.slice(0, limit);
    const files = [];
    for (const filePath of wanted) {
      try {
        files.push({
          ...(await gitCacheService.readFile({
            repository: preflight.pullRequest.repository,
            commit: preflight.pullRequest.sourceCommit,
            directory: preflight.gitCache.directory,
            external: preflight.gitCache.external ?? false,
            filePath,
          })),
          readOnly: true,
        });
      } catch {
        // 单个文件读取失败不阻断本轮；范围判定仍以 diff 为准
      }
    }
    return files;
  },

  /**
   * 相对上一轮的跟踪（FR-08 / AC12）。
   * 只能自动得出“仍存在”；本轮未再提及一律记为“无法确认”，等待人工判断。
   */
  buildCarryover(roundId) {
    const round = roundRepo.byId(roundId);
    if (!round) return [];
    const previous = roundRepo
      .listByPr(round.pullRequestId)
      .find((item) => item.roundNumber < round.roundNumber && item.aiResult);
    if (!previous) return [];

    const current = roundRepo.findings(roundId);
    const matchKey = (finding) =>
      `${finding.filePath ?? ''}::${finding.newLine ?? finding.oldLine ?? ''}::${finding.titleZh}`;
    const byKey = new Map(current.map((finding) => [finding.key, finding]));
    const byPlace = new Map(current.map((finding) => [matchKey(finding), finding]));

    const entries = [];
    for (const old of roundRepo.findings(previous.id)) {
      if (old.revision?.deleted) continue;
      const match = byKey.get(old.key) ?? byPlace.get(matchKey(old));
      entries.push(
        carryoverRepo.upsert({
          roundId,
          previousRoundId: previous.id,
          previousFindingId: old.id,
          currentFindingId: match?.id ?? null,
          verdict: match ? CarryoverVerdict.STILL_PRESENT : CarryoverVerdict.UNVERIFIABLE,
          note: match
            ? '本轮在同一位置再次命中同类问题'
            : '本轮未再提及；静态评审无法确认是否已修复，请人工判断',
        }),
      );
    }
    if (entries.length) {
      roundRepo.addEvent(
        roundId,
        'carryover',
        `已比对上一轮 ${entries.length} 条发现：仍存在 ${
          entries.filter((item) => item.verdict === CarryoverVerdict.STILL_PRESENT).length
        } 条，其余需人工确认`,
      );
    }
    return entries;
  },

  setCarryoverVerdict(id, verdict, note) {
    if (!Object.values(CarryoverVerdict).includes(verdict)) {
      throw validationError('跟踪结论只能是仍存在 / 已修复 / 无法确认');
    }
    const updated = carryoverRepo.setVerdict(id, verdict, note);
    if (!updated) throw notFound('跟踪记录不存在');
    auditRepo.record('user', 'carryover.verdict', id, { verdict });
    return updated;
  },

  cancel(roundId) {
    const round = roundRepo.byId(roundId);
    if (!round) throw notFound('评审轮次不存在');
    const controller = running.get(roundId);
    if (!controller) {
      if ([RoundStatus.PREFLIGHT, RoundStatus.RUNNING].includes(round.status)) {
        roundRepo.updateStatus(roundId, RoundStatus.CANCELLED, '任务已不在运行队列中');
      }
      return this.detail(roundId);
    }
    controller.abort();
    roundRepo.addEvent(roundId, 'cancelling', '已请求取消，正在终止子进程');
    auditRepo.record('user', 'review.cancel', roundId);
    return this.detail(roundId);
  },

  /** 报告是否仍然可发布：版本或需求指纹变化即过期（FR-07 / AC10）。 */
  freshness(round, pr) {
    if (round.status === RoundStatus.EXPIRED) {
      return { fresh: false, reason: round.statusReason ?? '本轮报告已过期' };
    }
    if (round.sourceCommit !== pr.sourceCommit || round.targetCommit !== pr.targetCommit) {
      return { fresh: false, reason: 'PR 的源/目标提交已变化，旧报告只读且不可发布' };
    }
    return { fresh: true, reason: null };
  },

  async verifyFreshnessAgainstRemote(round) {
    const clients = getClients();
    const stored = prRepo.byId(round.pullRequestId);
    const fresh = await clients.bitbucket.getPullRequest({
      repository: stored.repository,
      number: stored.number,
    });
    prRepo.upsert({ ...fresh, repository: stored.repository });

    const issues = [];
    for (const issue of round.jiraSnapshot?.issues ?? []) {
      try {
        issues.push(await clients.jira.getIssue(issue.key));
      } catch (error) {
        issues.push({ key: issue.key, error: error.message });
      }
    }
    const currentFingerprint = fingerprint({
      source: fresh.sourceCommit,
      target: fresh.targetCommit,
      scope: round.scope?.inScopeFiles ?? [],
      jira: jiraFingerprintParts({ issues }),
    });

    if (currentFingerprint !== round.inputFingerprint) {
      roundRepo.markExpired(round.id, 'PR 版本或关联需求在发布前发生变化，本次发布已取消');
      return { fresh: false, reason: 'PR 版本或关联需求在发布前发生变化，本次发布已取消', pullRequest: fresh };
    }
    return { fresh: true, reason: null, pullRequest: fresh };
  },

  detail(roundId) {
    const round = roundRepo.byId(roundId);
    if (!round) throw notFound('评审轮次不存在');
    const pr = prRepo.byId(round.pullRequestId);
    const findings = roundRepo.findings(roundId);
    const summaryRevision = roundRepo.summaryRevision(roundId);
    const demo = round.integrationMode !== 'live';

    return {
      round,
      pullRequest: pr,
      findings: findings.map((finding) => ({
        ...finding,
        effectiveCommentEn: stripSignature(finding.revision?.commentEn ?? finding.aiCommentEn),
        selected: finding.revision ? finding.revision.selected : true,
        deleted: finding.revision?.deleted ?? false,
      })),
      summary: {
        zh: round.summaryZh,
        aiEnDraft: round.summaryEnDraft,
        effectiveEn: stripSignature(summaryRevision?.summaryEn ?? round.summaryEnDraft ?? ''),
        overrideReasonEn: summaryRevision?.overrideReasonEn ?? '',
        updatedAt: summaryRevision?.updatedAt ?? null,
      },
      criteriaChecks: round.aiResult?.criteriaChecks ?? [],
      scopeCoverage: round.aiResult?.scopeCoverage ?? null,
      wikiConsulted: round.aiResult?.wikiConsulted ?? null,
      knowledgeBase: round.knowledgeBase ?? null,
      uncertainties: round.aiResult?.uncertainties ?? [],
      suggestedAction: round.aiResult?.suggestedAction ?? null,
      events: roundRepo.events(roundId),
      carryover: carryoverRepo.listByRound(roundId),
      attribution: round.model?.name
        ? buildChineseAttribution(round, pr, { demo })
        : null,
      draftSignature: round.model?.name
        ? buildEnglishSignature(round, { context: SignatureContext.DRAFT, demo })
        : null,
      freshness: this.freshness(round, pr),
      publishBatches: publishRepo.listByRound(roundId),
      demo,
      isRunning: running.has(roundId),
    };
  },

  listByPr(prId) {
    return roundRepo.listByPr(prId);
  },

  history(limit = HISTORY_LIMIT) {
    return roundRepo.listAll(limit).map((round) => ({
      ...round,
      publish: publishRepo.latestByRound(round.id),
    }));
  },

  /** 人工修订独立保存，不覆盖 AI 原文；正文编辑不含署名（FR-06 / FR-10）。 */
  updateFinding(findingId, patch) {
    const finding = roundRepo.findingById(findingId);
    if (!finding) throw notFound('发现不存在');
    const next = {};
    if (patch.commentEn !== undefined) {
      if (typeof patch.commentEn !== 'string') throw validationError('评论正文必须是字符串');
      next.commentEn = stripSignature(patch.commentEn);
    }
    if (patch.selected !== undefined) next.selected = Boolean(patch.selected);
    if (patch.deleted !== undefined) next.deleted = Boolean(patch.deleted);
    const updated = roundRepo.saveFindingRevision(findingId, next);
    auditRepo.record('user', 'finding.revise', findingId, Object.keys(next));
    return updated;
  },

  updateSummary(roundId, patch) {
    const round = roundRepo.byId(roundId);
    if (!round) throw notFound('评审轮次不存在');
    const next = {};
    if (patch.summaryEn !== undefined) next.summaryEn = stripSignature(String(patch.summaryEn));
    if (patch.overrideReasonEn !== undefined) {
      next.overrideReasonEn = stripSignature(String(patch.overrideReasonEn));
    }
    const updated = roundRepo.saveSummaryRevision(roundId, next);
    auditRepo.record('user', 'summary.revise', roundId, Object.keys(next));
    return updated;
  },
};
