import { AppError, ErrorKind } from '../../lib/errors.js';
import { createAuthResolver } from '../authScheme.js';
import { parseUnifiedDiff } from '../../domain/diff.js';

const DEFAULT_API_BASE = 'https://api.bitbucket.org/2.0';

/**
 * Bitbucket Cloud 只读查询 + 人工确认后的写入。
 *
 * 认证方式必须显式配置，不做猜测：
 * - basic：Atlassian 账号邮箱 + API token（App password 已废弃，个人集成的现行方式）
 * - bearer：仓库/工作区访问令牌或 OAuth access token
 *
 * 注意（requirements.md 第 9 章）：页面筛选条件与 API 查询参数的等价关系、
 * 行级评论锚点语义、评审状态切换行为仍需联调验证，本客户端按官方参考实现，
 * 任何未验证的分支都以明确错误暴露，不做静默降级。
 */
export function createLiveBitbucketClient({
  getToken,
  authScheme = 'auto',
  email = '',
  apiBase = DEFAULT_API_BASE,
  includeDrafts = true,
} = {}) {
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
  const auth = createAuthResolver({ label: 'Bitbucket', authScheme, email });
  /**
   * 当前身份在一次进程生命周期内是稳定的，但刷新列表、读 PR 详情、发布评论都要用它。
   * 不缓存的话每个操作都要多一次 /user 往返；凭据或连接设置变更时 registry 会重建客户端，
   * 缓存随之失效，不会拿着旧身份继续用。
   */
  let currentUserPromise = null;

  async function request(pathname, { method = 'GET', body, query, accept = 'json' } = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const token = await getToken();
    if (!token) throw new AppError(ErrorKind.AUTH, 'Bitbucket 凭据缺失，请在连接设置中录入。');
    // 认证头在 try 之外构造：否则「缺邮箱/缺凭据」这类配置错误会被统一吞成网络错误。
    const attempts = auth.plan(token);

    let response;
    const tried = [];
    for (const [index, attempt] of attempts.entries()) {
      tried.push(attempt.scheme);
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: attempt.value,
            accept: accept === 'json' ? 'application/json' : 'text/plain',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (cause) {
        throw new AppError(
          ErrorKind.NETWORK,
          `Bitbucket 网络请求失败：${cause?.cause?.message ?? cause?.message ?? '未知原因'}`,
          {
            cause,
            details: { url: `${url.origin}${url.pathname}` },
            remedy:
              '请确认 API 基地址是否正确（Cloud 为 https://api.bitbucket.org/2.0，自建 Server/Data Center 为 https://<host>/rest/api/1.0），以及是否需要公司代理。',
          },
        );
      }
      const canRetry = auth.rejected(response.status) && index < attempts.length - 1;
      if (!canRetry) {
        if (!auth.rejected(response.status)) auth.confirm(attempt.scheme);
        break;
      }
    }

    if (response.status === 401) throw auth.authError(tried);
    if (response.status === 403) throw new AppError(ErrorKind.PERMISSION, 'Bitbucket 权限不足。');
    if (response.status === 429) {
      throw new AppError(ErrorKind.RATE_LIMIT, 'Bitbucket 触发限流，请稍后重试。', {
        details: { retryAfter: response.headers.get('retry-after') },
      });
    }
    if (response.status === 404) throw new AppError(ErrorKind.NOT_FOUND, 'Bitbucket 资源不存在。');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError(ErrorKind.UPSTREAM, `Bitbucket 返回 ${response.status}`, {
        details: { body: text.slice(0, 500) },
      });
    }
    return accept === 'json' ? response.json() : response.text();
  }

  async function paginate(pathname, query) {
    const values = [];
    let page = await request(pathname, { query: { pagelen: 50, ...query } });
    values.push(...(page.values ?? []));
    let next = page.next;
    let guard = 0;
    while (next && guard < 200) {
      guard += 1;
      const url = new URL(next);
      if (!next.startsWith(base)) {
        throw new AppError(ErrorKind.UPSTREAM, '分页地址与配置的 API 基地址不一致，已停止翻页', {
          details: { next },
        });
      }
      page = await request(url.pathname.slice(new URL(base).pathname.length), {
        query: Object.fromEntries(url.searchParams),
      });
      values.push(...(page.values ?? []));
      next = page.next;
    }
    return values;
  }

  const mapPr = (repository, pr) => ({
    repository,
    number: pr.id,
    title: pr.title,
    description: pr.description ?? '',
    author: { id: pr.author?.uuid ?? null, name: pr.author?.display_name ?? null },
    sourceBranch: pr.source?.branch?.name ?? null,
    targetBranch: pr.destination?.branch?.name ?? null,
    sourceCommit: pr.source?.commit?.hash ?? null,
    targetCommit: pr.destination?.commit?.hash ?? null,
    lifecycleState: pr.state,
    isDraft: Boolean(pr.draft),
    updatedAt: pr.updated_on,
    raw: { links: pr.links?.html?.href ?? null },
  });

  return {
    mode: 'live',

    async testConnection() {
      // 连接测试必须真的打一次网络请求，不能拿缓存身份冒充成功。
      const user = await this.getCurrentUser({ refresh: true });
      return { ok: true, demo: false, detail: `已连接 Bitbucket，当前身份 ${user.displayName}` };
    },

    async getCurrentUser({ refresh = false } = {}) {
      if (refresh || !currentUserPromise) {
        currentUserPromise = request('/user').then(
          (user) => ({
            id: user.uuid,
            accountId: user.account_id,
            displayName: user.display_name,
            nickname: user.nickname,
          }),
          (error) => {
            currentUserPromise = null;
            throw error;
          },
        );
      }
      return currentUserPromise;
    },

    /**
     * 「待我评审」列表（FR-01 / AC01）：用 API 返回的稳定用户标识匹配评审人，不依赖显示名。
     *
     * 过滤必须放在服务端：仓库里的 OPEN PR 动辄数百个，全量翻页再本地筛选
     * 会拉回几十倍于所需的数据，刷新自然慢。这里用 BBQL 让 Bitbucket 只返回
     * 「我是评审人且未关闭」的 PR，通常一页就够。
     *
     * 字段也显式裁剪：默认响应会带上 rendered HTML、头像链接、各种 self link，
     * 列表一个都用不到。注意 fields 语义——一旦出现不带 + 前缀的字段名，
     * Bitbucket 会切换成「仅返回这些字段」，所以下面必须把 id 在内的所有字段列全，
     * 并保留 next 才能继续翻页。
     */
    async listPullRequestsForReview({ repository }) {
      const user = await this.getCurrentUser();
      // 页面的 state=OPEN+DRAFT 与 API 参数并非一一对应：Draft 仍属于 OPEN，
      // 由 draft 字段区分，因此统一按 OPEN 查询后再按设置过滤（第 9 章待验证项）。
      const values = await paginate(`/repositories/${repository}/pullrequests`, {
        q: `state="OPEN" AND reviewers.uuid="${user.id}"`,
        fields: [
          'next',
          'values.id',
          'values.title',
          'values.description',
          'values.state',
          'values.draft',
          'values.updated_on',
          'values.author.uuid',
          'values.author.display_name',
          'values.source.branch.name',
          'values.source.commit.hash',
          'values.destination.branch.name',
          'values.destination.commit.hash',
          'values.links.html.href',
          // 我这一轮的表态只能从 participants 读；只取判定所需的三个字段。
          'values.participants.user.uuid',
          'values.participants.role',
          'values.participants.state',
        ].join(','),
      });
      return values
        .filter((pr) => includeDrafts || !pr.draft)
        .map((pr) => {
          const participant = (pr.participants ?? []).find((item) => item.user?.uuid === user.id);
          return {
            ...mapPr(repository, pr),
            myReviewState:
              participant?.state === 'approved'
                ? 'approved'
                : participant?.state === 'changes_requested'
                  ? 'changes_requested'
                  : 'none',
          };
        });
    },

    async getPullRequest({ repository, number }) {
      const pr = await request(`/repositories/${repository}/pullrequests/${number}`);
      const user = await this.getCurrentUser();
      const participant = (pr.participants ?? []).find((item) => item.user?.uuid === user.id);
      return {
        ...mapPr(repository, pr),
        myReviewState:
          participant?.state === 'approved'
            ? 'approved'
            : participant?.state === 'changes_requested'
              ? 'changes_requested'
              : 'none',
      };
    },

    async getDiff({ repository, number }) {
      const text = await request(`/repositories/${repository}/pullrequests/${number}/diff`, {
        accept: 'text',
      });
      return parseUnifiedDiff(text);
    },

    async listComments({ repository, number }) {
      const values = await paginate(`/repositories/${repository}/pullrequests/${number}/comments`);
      return values.map((comment) => ({
        id: String(comment.id),
        body: comment.content?.raw ?? '',
        filePath: comment.inline?.path ?? null,
        line: comment.inline?.to ?? comment.inline?.from ?? null,
        lineSide: comment.inline?.to ? 'new' : comment.inline?.from ? 'old' : null,
        authorId: comment.user?.uuid ?? null,
        createdAt: comment.created_on,
      }));
    },

    async createComment({ repository, number, body, filePath = null, line = null, lineSide = 'new' }) {
      const payload = { content: { raw: body } };
      if (filePath && line) {
        payload.inline = { path: filePath, ...(lineSide === 'old' ? { from: line } : { to: line }) };
      }
      const created = await request(`/repositories/${repository}/pullrequests/${number}/comments`, {
        method: 'POST',
        body: payload,
      });
      return { id: String(created.id), createdAt: created.created_on };
    },

    async findOwnCommentByBody({ repository, number, body }) {
      const user = await this.getCurrentUser();
      const comments = await this.listComments({ repository, number });
      const hit = comments.find((comment) => comment.authorId === user.id && comment.body === body);
      return hit ? { id: hit.id, createdAt: hit.createdAt } : null;
    },

    async setReviewState({ repository, number, action }) {
      const endpoint = {
        approve: 'approve',
        request_changes: 'request-changes',
      }[action];
      if (!endpoint) throw new AppError(ErrorKind.VALIDATION, `不支持的评审动作：${action}`);
      const result = await request(
        `/repositories/${repository}/pullrequests/${number}/${endpoint}`,
        { method: 'POST' },
      );
      return {
        state: result?.state === 'approved' ? 'approved' : 'changes_requested',
        at: result?.date ?? new Date().toISOString(),
      };
    },

    async refresh(params) {
      return this.getPullRequest(params);
    },
  };
}
