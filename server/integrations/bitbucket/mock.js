import { AppError, ErrorKind } from '../../lib/errors.js';
import { MOCK_PULL_REQUESTS, MOCK_USER } from './mockData.js';

/**
 * Bitbucket 演示适配器：在内存中模拟只读查询与发布写入。
 * 不访问任何远端服务，仅用于在缺少真实凭据时跑通本地流程。
 */
export function createMockBitbucketClient() {
  const state = structuredClone(MOCK_PULL_REQUESTS);
  const byNumber = new Map(state.map((pr) => [pr.number, pr]));
  let commentSeq = 9000;

  const require = (number) => {
    const pr = byNumber.get(Number(number));
    if (!pr) throw new AppError(ErrorKind.NOT_FOUND, `演示数据中不存在 PR #${number}`);
    return pr;
  };

  const toSummary = (pr) => ({
    repository: pr.repository,
    number: pr.number,
    title: pr.title,
    description: pr.description,
    author: pr.author,
    authoredByMe: pr.author?.id === MOCK_USER.id,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    sourceCommit: pr.sourceCommit,
    targetCommit: pr.targetCommit,
    lifecycleState: pr.lifecycleState,
    isDraft: pr.isDraft,
    myReviewState: pr.myReviewState,
    updatedAt: pr.updatedAt,
  });

  return {
    mode: 'mock',

    async testConnection() {
      return {
        ok: true,
        demo: true,
        detail: '演示模式：未连接真实 Bitbucket，数据为本地构造样例。',
      };
    },

    async getCurrentUser() {
      return { ...MOCK_USER, demo: true };
    },

    /** 与真实适配器一致：我评审的 + 我发起的，两类都要列出。 */
    async listPullRequestsForReview({ repository }) {
      const user = await this.getCurrentUser();
      return state
        .filter(
          (pr) =>
            pr.repository === repository &&
            (pr.reviewers.includes(user.id) || pr.author?.id === user.id),
        )
        .map(toSummary);
    },

    async getPullRequest({ number }) {
      return toSummary(require(number));
    },

    async getDiff({ number }) {
      return structuredClone(require(number).diff);
    },

    async listComments({ number }) {
      return structuredClone(require(number).comments);
    },

    /** 发布行级或 PR 级评论；调用方负责去重与最终确认。 */
    async createComment({ number, body, filePath = null, line = null, lineSide = 'new' }) {
      const pr = require(number);
      commentSeq += 1;
      const comment = {
        id: String(commentSeq),
        body,
        filePath,
        line,
        lineSide,
        authorId: MOCK_USER.id,
        createdAt: new Date().toISOString(),
      };
      pr.comments.push(comment);
      return { id: comment.id, createdAt: comment.createdAt };
    },

    /** 写入超时后用于核实远端是否已经产生内容，避免重复评论（FR-07）。 */
    async findOwnCommentByBody({ number, body }) {
      const pr = require(number);
      const hit = pr.comments.find(
        (comment) => comment.authorId === MOCK_USER.id && comment.body === body,
      );
      return hit ? { id: hit.id, createdAt: hit.createdAt } : null;
    },

    async setReviewState({ number, action }) {
      const pr = require(number);
      if (pr.isDraft) {
        throw new AppError(ErrorKind.PRECONDITION, 'Draft PR 不允许发布状态性评审结果', {
          remedy: '请等待作者将 PR 转为正式 PR 后再更新评审状态。',
        });
      }
      const mapping = { approve: 'approved', request_changes: 'changes_requested' };
      const next = mapping[action];
      if (!next) throw new AppError(ErrorKind.VALIDATION, `不支持的评审动作：${action}`);
      pr.myReviewState = next;
      return { state: next, at: new Date().toISOString() };
    },

    /** 测试与演示用：让调用方可以重新读到远端最新状态。 */
    async refresh({ number }) {
      return toSummary(require(number));
    },
  };
}
