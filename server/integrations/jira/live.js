import { AppError, ErrorKind } from '../../lib/errors.js';
import { createAuthResolver } from '../authScheme.js';

/**
 * Jira 只读客户端。
 *
 * 待确认（requirements.md 第 9 章）：实例类型（Cloud / Data Center）、基础 URL、
 * 认证方式与验收标准自定义字段 ID。字段映射必须由用户在连接设置中显式配置，
 * 不允许代码猜测字段，也不允许在读取失败时伪造验收标准。
 */
export function createLiveJiraClient({ baseUrl, email, getToken, acceptanceFieldId, authScheme = 'auto' }) {
  const auth = createAuthResolver({ label: 'Jira', authScheme, email });

  async function request(pathname, query) {
    if (!baseUrl) {
      throw new AppError(ErrorKind.VALIDATION, 'Jira 基础地址未配置', {
        remedy: '请在连接设置中填写 Jira 实例地址与验收标准字段 ID。',
      });
    }
    const token = await getToken();
    if (!token) throw new AppError(ErrorKind.AUTH, 'Jira 凭据缺失，请在连接设置中录入。');

    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    const tried = [];
    const attempts = auth.plan(token);
    for (const [index, attempt] of attempts.entries()) {
      tried.push(attempt.scheme);
      try {
        response = await fetch(url, {
          headers: { authorization: attempt.value, accept: 'application/json' },
        });
      } catch (cause) {
        throw new AppError(
          ErrorKind.NETWORK,
          `Jira 网络请求失败：${cause?.cause?.message ?? cause?.message ?? '未知原因'}`,
          { cause, details: { url: `${url.origin}${url.pathname}` } },
        );
      }
      const canRetry = auth.rejected(response.status) && index < attempts.length - 1;
      if (!canRetry) {
        if (!auth.rejected(response.status)) auth.confirm(attempt.scheme);
        break;
      }
    }

    if (response.status === 401) throw auth.authError(tried);
    if (response.status === 403) {
      // Jira Cloud 对「认证方式不被允许」也返回 403，必须把原因回显，
      // 否则和真正的权限不足无法区分。
      const body = await response.text().catch(() => '');
      const hint = response.headers.get('x-authentication-denied-reason');
      throw new AppError(ErrorKind.PERMISSION, `Jira 拒绝访问（403）${hint ? `：${hint}` : ''}`, {
        details: { tried, url: `${url.origin}${url.pathname}`, body: body.slice(0, 300) },
        remedy:
          'Jira Cloud 需要「账号邮箱 + Atlassian API token」的 Basic 认证（Bearer 仅适用于 OAuth 或 Data Center 的 PAT）；请把「账号邮箱」填成完整邮箱地址。',
      });
    }
    if (response.status === 429) throw new AppError(ErrorKind.RATE_LIMIT, 'Jira 触发限流，请稍后重试。');
    if (response.status === 404) {
      throw new AppError(ErrorKind.NOT_FOUND, 'Jira 接口不存在或无权访问', {
        details: { url: `${url.origin}${url.pathname}` },
        remedy: '请确认实例地址只填到站点根（例如 https://your-site.atlassian.net），不要带 /jira 等子路径。',
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AppError(ErrorKind.UPSTREAM, `Jira 返回 ${response.status}`, {
        details: { body: body.slice(0, 300) },
      });
    }
    return response.json();
  }

  /** 验收标准按配置字段解析为逐条记录；字段缺失时返回空数组并由上层阻断。 */
  function parseAcceptanceCriteria(key, fields) {
    if (!acceptanceFieldId) return [];
    const raw = fields?.[acceptanceFieldId];
    const text = typeof raw === 'string' ? raw : renderAdf(raw);
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
      .filter(Boolean)
      .map((item, index) => ({ id: `${key}-AC${index + 1}`, text: item }));
  }

  function renderAdf(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return node.text ?? '';
    const children = (node.content ?? []).map(renderAdf).join(node.type === 'paragraph' ? '' : '\n');
    return node.type === 'paragraph' || node.type === 'listItem' ? `${children}\n` : children;
  }

  return {
    mode: 'live',

    async testConnection() {
      const me = await request('/rest/api/3/myself');
      return { ok: true, demo: false, detail: `已连接 Jira，当前身份 ${me.displayName}` };
    },

    async getIssue(key) {
      const fieldList = ['summary', 'status', 'issuetype', 'updated', 'description'];
      if (acceptanceFieldId) fieldList.push(acceptanceFieldId);
      const issue = await request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
        fields: fieldList.join(','),
      });
      const fields = issue.fields ?? {};
      return {
        key: issue.key,
        summary: fields.summary ?? null,
        issueType: fields.issuetype?.name ?? null,
        status: fields.status?.name ?? null,
        updatedAt: fields.updated ?? null,
        url: new URL(`/browse/${issue.key}`, baseUrl).toString(),
        description: typeof fields.description === 'string' ? fields.description : renderAdf(fields.description),
        acceptanceCriteria: parseAcceptanceCriteria(issue.key, fields),
        links: [],
      };
    },
  };
}
