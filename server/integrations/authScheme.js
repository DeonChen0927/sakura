import { AppError, ErrorKind } from '../lib/errors.js';

/**
 * 令牌认证方式解析（Bitbucket / Jira 通用）。
 *
 * 只给一个 token 也要能用：默认 auto —— 先试 Bearer（访问令牌 / PAT / OAuth），
 * 401 再退回 Basic（Atlassian API token，需要账号邮箱）。成功的方式会被记住，
 * 后续请求不再重复试探；两种都失败时如实报认证错误并说明试过什么。
 */
export function createAuthResolver({ label, authScheme = 'auto', email = '' }) {
  let resolved = authScheme === 'auto' ? null : authScheme;
  let atlassianToken = false;

  const header = (scheme, token) =>
    scheme === 'bearer'
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  function candidates() {
    if (resolved) return [resolved];
    if (authScheme === 'basic' || authScheme === 'bearer') return [authScheme];
    if (authScheme !== 'auto') {
      throw new AppError(ErrorKind.VALIDATION, `不支持的${label}认证方式：${authScheme}`);
    }
    return email ? ['bearer', 'basic'] : ['bearer'];
  }

  return {
    get scheme() {
      return resolved ?? authScheme;
    },

    /** 依次返回可尝试的认证头；调用方在认证被拒时继续取下一个。 */
    plan(token) {
      const list = candidates();
      atlassianToken = token.startsWith('ATATT');
      if (list.includes('basic') && !email) {
        throw new AppError(
          ErrorKind.PRECONDITION,
          `${label} 的 Basic 认证需要账号邮箱`,
          { remedy: '请在连接设置中填写邮箱，或改用访问令牌 / PAT（Bearer）。' },
        );
      }
      if (email && !email.includes('@')) {
        throw new AppError(ErrorKind.PRECONDITION, `${label} 的账号邮箱格式不正确：${email}`, {
          remedy: 'Basic 认证的用户名必须是完整邮箱地址（例如 name@company.com），不能只填用户名。',
        });
      }
      return list.map((scheme) => ({ scheme, value: header(scheme, token) }));
    },

    /** 认证方式不匹配时，Atlassian 可能返回 401 也可能返回 403，两者都要继续回退。 */
    rejected(status) {
      return status === 401 || status === 403;
    },

    confirm(scheme) {
      resolved = scheme;
    },

    /** 全部方式都被拒绝时的统一报错，写清试过哪些方式，避免用户盲猜。 */
    authError(tried) {
      const names = tried.map((scheme) => (scheme === 'bearer' ? 'Bearer 访问令牌' : 'Basic 邮箱+API token'));
      const remedy =
        atlassianToken && !email
          ? '当前令牌是 Atlassian 账号 API token（ATATT 开头），这类令牌通常需要配合账号邮箱走 Basic 认证；请在连接设置中把「账号邮箱」填成完整邮箱地址。'
          : email
            ? '请确认令牌未过期、与当前实例匹配，并具备所需权限范围。'
            : '若使用的是 Atlassian 账号 API token，还需要在连接设置中填写账号邮箱；访问令牌 / PAT 则只需令牌本身。';
      return new AppError(ErrorKind.AUTH, `${label} 认证失败（已尝试：${names.join('、')}）`, { remedy });
    },
  };
}
