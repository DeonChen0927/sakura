import { getClients } from '../integrations/registry.js';
import { prRepo } from '../db/repositories/prRepo.js';
import { roundRepo, RoundStatus } from '../db/repositories/roundRepo.js';
import { publishRepo } from '../db/repositories/publishRepo.js';
import { settingsService, SettingKey } from './settingsService.js';
import { auditRepo } from '../db/repositories/auditRepo.js';
import { resolveTeamSealScope, resolveFullChangeScope, ScopePolicy } from '../domain/teamSeal.js';
import { teamRosterService } from './teamRosterService.js';
import { knowledgeBaseService } from './knowledgeBaseService.js';
import { gitCacheService } from './gitCacheService.js';
import { extractJiraKeys, validateJiraSnapshot, jiraFingerprintParts } from '../domain/jira.js';
import { diffStats } from '../domain/diff.js';
import { fingerprint } from '../lib/ids.js';
import { notFound } from '../lib/errors.js';

const diffCache = new Map();

async function loadDiff(clients, repository, number, sourceCommit) {
  const key = `${repository}#${number}@${sourceCommit}`;
  if (diffCache.has(key)) return diffCache.get(key);
  const files = await clients.bitbucket.getDiff({ repository, number });
  diffCache.set(key, files);
  return files;
}

export const prService = {
  /**
   * 手动刷新：只刷新远端数据，不自动发起 AI 评审（FR-02）。
   * 同时与远端对账：不再列为「待我评审」的快照（已合并、已关闭、被移出评审人，
   * 或早期演示数据遗留）不能继续留在列表里冒充待办。
   */
  async sync() {
    const clients = getClients();
    const repository = settingsService.repository();
    const list = await clients.bitbucket.listPullRequestsForReview({ repository });
    for (const pr of list) {
      const saved = prRepo.upsert({ ...pr, repository });
      if (saved.remoteMissing) prRepo.markMissing(saved.id, false);
      this.closeRoundsSettledRemotely(saved);
    }

    const present = new Set(list.map((pr) => `${repository}#${pr.number}`));
    const reconciled = { removed: 0, archived: 0 };
    for (const pr of prRepo.listAll(repository)) {
      if (present.has(pr.id)) continue;
      if (pr.archivedAt) continue;
      // 远端不再列为待我评审（已合并 / 已关闭 / 被移出评审人）：退出工作台。
      // 有评审痕迹的归档保留，历史仍可查；纯粹的陈旧快照直接清掉。
      if (roundRepo.listByPr(pr.id).length) {
        if (!pr.remoteMissing) prRepo.markMissing(pr.id, true);
        // 最后一次同步时我已表态的，挂着的「待你确认」一并结算。
        this.closeRoundsSettledRemotely(pr);
        prRepo.archive(pr.id, true);
        reconciled.archived += 1;
      } else {
        prRepo.remove(pr.id);
        reconciled.removed += 1;
      }
    }

    auditRepo.record('user', 'pr.sync', repository, {
      count: list.length,
      mode: clients.mode,
      ...reconciled,
    });
    return this.list();
  },

  /**
   * 你本人已经在 Bitbucket 表态时，本地还挂着的「待你确认」轮次自动结束（用户决定）。
   * 状态写成 closed_remote 而不是「已确认」：不伪造你在 Sakura 里做过确认，
   * 报告仍可查看与发布，只是不再占用待办。
   */
  closeRoundsSettledRemotely(pr) {
    const settled = pr.myReviewState === 'approved' || pr.myReviewState === 'changes_requested';
    if (!settled) return null;
    const latest = roundRepo.latestByPr(pr.id);
    if (!latest || latest.status !== RoundStatus.AWAITING_CONFIRMATION) return null;

    const label = pr.myReviewState === 'approved' ? 'Approved' : 'Changes requested';
    const reason = `你已在 Bitbucket 表态（${label}），本轮自动结束`;
    roundRepo.addEvent(latest.id, RoundStatus.CLOSED_REMOTE, reason);
    const updated = roundRepo.updateStatus(latest.id, RoundStatus.CLOSED_REMOTE, reason);
    auditRepo.record('system', 'review.closed_remote', latest.id, {
      pr: pr.number,
      remoteState: pr.myReviewState,
    });
    return updated;
  },

  list() {
    const repository = settingsService.repository();
    const prs = prRepo.list(repository);
    return {
      repository,
      syncedAt: prRepo.lastSyncedAt(repository),
      mode: settingsService.integrationMode(),
      items: prs.map((pr) => {
        const latest = roundRepo.latestByPr(pr.id);
        return {
          ...pr,
          localState: this.localState(pr, latest),
          latestRound: latest
            ? { id: latest.id, roundNumber: latest.roundNumber, status: latest.status }
            : null,
          jiraKeys: extractJiraKeys(pr).map((item) => item.key),
        };
      }),
    };
  },

  /** 本地评审轮次状态是独立维度，不与远端评审状态混用（第 6 章）。 */
  localState(pr, latestRound) {
    if (!latestRound) return RoundStatus.PENDING;
    const settled = [RoundStatus.AWAITING_CONFIRMATION, RoundStatus.CLOSED_REMOTE].includes(
      latestRound.status,
    );
    if (!settled) return latestRound.status;
    const stale =
      latestRound.sourceCommit !== pr.sourceCommit || latestRound.targetCommit !== pr.targetCommit;
    if (stale) return RoundStatus.EXPIRED;
    const batch = publishRepo.latestByRound(latestRound.id);
    return batch?.status === 'succeeded' ? 'published' : latestRound.status;
  },

  byId(id) {
    const pr = prRepo.byId(id);
    if (!pr) throw notFound(`本地没有 PR ${id} 的快照，请先刷新列表`);
    return pr;
  },

  /**
   * 启动前检查（FR-03 / FR-04 / AC02 / AC04）：
   * 范围识别与 Jira 读取任一失败都阻断，不把不完整信息视为通过。
   */
  async preflight(prId, { manualJiraKeys = [] } = {}) {
    const clients = getClients();
    const stored = this.byId(prId);
    const fresh = await clients.bitbucket.getPullRequest({
      repository: stored.repository,
      number: stored.number,
    });
    const pr = prRepo.upsert({ ...fresh, repository: stored.repository });
    // 打开详情时也按远端表态结算，不必等下一次列表刷新。
    this.closeRoundsSettledRemotely(pr);

    const diffFiles = await loadDiff(clients, pr.repository, pr.number, pr.sourceCommit);
    const scope = await this.resolveScope(clients, pr, diffFiles);

    const candidates = extractJiraKeys(pr, [
      ...settingsService.manualJiraKeys(pr.id),
      ...manualJiraKeys,
    ]);
    const issues = [];
    for (const candidate of candidates) {
      try {
        const issue = await clients.jira.getIssue(candidate.key);
        issues.push({ ...issue, sources: candidate.sources });
      } catch (error) {
        issues.push({ key: candidate.key, sources: candidate.sources, error: error.message });
      }
    }
    const jiraSnapshot = { issues, capturedAt: new Date().toISOString() };
    const jiraCheck = validateJiraSnapshot(jiraSnapshot);

    const model = settingsService.getReviewModel();
    const blockers = [...(scope.blockers ?? []), ...jiraCheck.blockers];

    if (model.invalid) {
      blockers.push({
        code: 'model_config_invalid',
        message: '已保存的评审模型配置无效或已损坏。',
        remedy: '请在连接设置中重新选择评审模型；系统不会静默重置配置。',
      });
    }

    if (pr.lifecycleState && pr.lifecycleState !== 'OPEN') {
      blockers.push({
        code: 'pr_not_open',
        message: `该 PR 的远端状态是 ${pr.lifecycleState}，已经不是可评审对象。`,
        remedy: '请刷新列表；已合并或已关闭的 PR 不需要再评审。',
      });
    }

    if (pr.remoteMissing) {
      blockers.push({
        code: 'not_my_review',
        message:
          'Bitbucket 已不再把该 PR 列为待你评审、也不再由你发起（可能已合并、已关闭，或你已被移出评审人）。',
        remedy: '请刷新列表确认；本地保留这条记录只是为了查看历史。',
      });
    }

    const draftPolicy = settingsService.get(SettingKey.DRAFT_POLICY);
    const warnings = [...(scope.warnings ?? []), ...(jiraCheck.warnings ?? [])];
    if (pr.isDraft) {
      warnings.push({
        code: 'draft_pr',
        message: 'Draft PR 可以生成报告，但禁止发布状态性评审结果，直到转为正式 PR。',
      });
      if (!draftPolicy.allowReview) {
        blockers.push({ code: 'draft_blocked', message: '当前策略禁止评审 Draft PR。' });
      }
    }

    if (roundRepo.hasActiveForPr(pr.id)) {
      blockers.push({
        code: 'round_running',
        message: '该 PR 已有正在运行的评审轮次，同一 PR 同时只允许一轮。',
      });
    }

    // Git 缓存只提供只读上下文，不可用不阻断评审，但必须如实展示（D06 / FR-03）
    const gitCache = await gitCacheService.ensureCommits({
      repository: pr.repository,
      commits: [pr.sourceCommit, pr.targetCommit],
      branches: [pr.sourceBranch, pr.targetBranch],
    });
    if (!gitCache.available) {
      warnings.push({
        code: 'git_cache_unavailable',
        message: `本地 Git 缓存不可用：${gitCache.reason}。评审只使用 PR diff，不含仓库其余上下文。`,
      });
    }

    /**
     * 知识库（FR-12）：评审必须经 ei-ai-skills 的 ei-llm-wiki skill 使用 EI 工程 wiki。
     * wiki 只需要 clone 一次，所以这里用 ensure()：缺 checkout 就自动克隆，不让用户先去手工准备。
     * 克隆不成时才阻断 —— 静默退化成「只看 diff」会让报告看起来一样完整，
     * 实际却丢掉了子系统约定与历史缺陷这类只有 wiki 才有的判断依据。
     */
    const knowledgeBase = await knowledgeBaseService.ensure();
    if (!knowledgeBase.enabled) {
      warnings.push({
        code: 'knowledge_base_disabled',
        message: '知识库已在设置中关闭，本轮不会检索 ei-llm-wiki，评审只依据代码与需求。',
      });
    } else if (knowledgeBase.demo) {
      warnings.push({
        code: 'knowledge_base_demo',
        message: '演示模式不会调用 ei-llm-wiki 知识库，报告中的结论不含任何 wiki 依据。',
      });
    } else if (!knowledgeBase.available) {
      const entry = {
        code: 'knowledge_base_unavailable',
        message: `EI wiki 知识库不可用：${knowledgeBase.detail}`,
        remedy: knowledgeBase.remedy,
      };
      if (knowledgeBase.required) blockers.push(entry);
      else warnings.push(entry);
    } else if (knowledgeBase.wiki?.head?.stale) {
      warnings.push({
        code: 'knowledge_base_stale',
        message: `知识库 checkout 最后一次提交在 ${knowledgeBase.wiki.head.ageDays} 天前，可能已落后于远端。`,
        remedy: '可在「连接设置 → 知识库」点击刷新，再开始评审。',
      });
    }

    return {
      pullRequest: pr,
      diff: { files: diffFiles, stats: diffStats(diffFiles) },
      scope,
      jiraSnapshot,
      jiraCheck,
      gitCache,
      knowledgeBase,
      manualJiraKeys: settingsService.manualJiraKeys(pr.id),
      model,
      warnings,
      blockers,
      canStart: blockers.length === 0,
      inputFingerprint: fingerprint({
        source: pr.sourceCommit,
        target: pr.targetCommit,
        scope: scope.inScopeFiles,
        jira: jiraFingerprintParts(jiraSnapshot),
      }),
    };
  },

  /**
   * 评审范围（FR-03）。先判作者归属，再谈 Team Seal 范围标记：
   *
   * - 我自己发起的 PR、以及 Team Seal 成员发起的 PR → 整份评审全部变更文件。
   *   Codeowner Bot 的 Seal 范围标记是给「别的团队改到我们代码」划的界，
   *   用它来限制本团队自己的 PR 会把大部分改动排除在评审之外，属于漏评。
   * - 其余 PR 才按标记划定的 Seal 范围评审。
   *
   * 名单读不到时不阻断，按原有 Seal 范围评审，并明确警告名单不可用 ——
   * 不静默假装「作者不是成员」，否则漏评了也看不出来。
   */
  async resolveScope(clients, pr, diffFiles) {
    if (pr.authoredByMe) {
      return resolveFullChangeScope(diffFiles, {
        policy: ScopePolicy.AUTHOR_IS_ME,
        reason: '这是你本人发起的 PR，按全部变更文件评审，不套用 Team Seal 范围。',
      });
    }

    const rosterWarnings = [];
    const lookup = teamRosterService.isMember(pr.author?.accountId);
    if (lookup.member) {
      return resolveFullChangeScope(diffFiles, {
        policy: ScopePolicy.AUTHOR_IN_TEAM,
        reason: `发起人 ${lookup.member.name ?? pr.author?.name ?? '未知'} 属于 ${lookup.roster.team} 团队，按全部变更文件评审，不套用 Team Seal 范围。`,
      });
    }
    if (!lookup.ok) {
      rosterWarnings.push({
        code: 'team_roster_unavailable',
        message: `无法读取 ${teamRosterService.teamName()} 团队名单，因此无法确认发起人是否为团队成员：${lookup.roster.detail}`,
        remedy:
          lookup.roster.remedy ??
          '本轮按 Team Seal 范围评审；若发起人其实是团队成员，评审范围会偏小，请修好名单后重新开始。',
      });
    } else if (!pr.author?.accountId) {
      rosterWarnings.push({
        code: 'team_roster_author_unknown',
        message: '这条 PR 快照里没有发起人的 Bitbucket account_id，无法与团队名单比对。',
        remedy: '请刷新列表重新同步该 PR；旧版本保存的快照不含该字段。',
      });
    }

    // Team Seal 范围标记由 Codeowner Bot 发在评论里，PR 描述经常是空的，
    // 因此描述与评论都要作为来源。评论读取失败不能静默当成「没有标记」。
    let comments = [];
    let commentsError = null;
    try {
      comments = await clients.bitbucket.listComments({
        repository: pr.repository,
        number: pr.number,
      });
    } catch (error) {
      commentsError = error.message;
    }
    const scopeSources = [
      { text: pr.description, origin: 'description' },
      ...comments.map((comment) => ({ text: comment.body, origin: `comment:${comment.id}` })),
    ];
    const scope = resolveTeamSealScope(scopeSources, diffFiles);
    if (commentsError && scope.fallback) {
      scope.warnings.push({
        code: 'scope_comments_unavailable',
        message: `无法读取 PR 评论，可能因此漏掉 Team Seal 范围标记：${commentsError}`,
        remedy: '请确认令牌具备读取 PR 评论的权限后重试。',
      });
    }
    scope.warnings.unshift(...rosterWarnings);
    return scope;
  },

  async diff(prId) {
    const clients = getClients();
    const pr = this.byId(prId);
    const files = await loadDiff(clients, pr.repository, pr.number, pr.sourceCommit);
    return { files, stats: diffStats(files) };
  },

  invalidateDiffCache() {
    diffCache.clear();
  },
};
