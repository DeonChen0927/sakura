import { randomBytes } from 'node:crypto';
import { AppError, ErrorKind } from '../lib/errors.js';
import { parseCookies } from '../lib/http.js';

const SESSION_COOKIE = 'sakura_session';
const CSRF_COOKIE = 'sakura_csrf';
const CSRF_HEADER = 'x-sakura-csrf';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const isLoopbackHost = (host) => {
  if (!host) return false;
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  return LOOPBACK_HOSTNAMES.has(hostname);
};

const token = () => randomBytes(24).toString('base64url');

function setCookie(res, name, value, { httpOnly }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Strict',
    'Max-Age=86400',
  ];
  if (httpOnly) parts.push('HttpOnly');
  const existing = res.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  list.push(parts.join('; '));
  res.setHeader('set-cookie', list);
}

/**
 * 即使只监听回环地址，也校验 Origin/Host 防跨站请求，并对变更请求要求本地会话与
 * CSRF token（第 7 章 本地架构）。
 */
export function guardRequest(req, res) {
  const host = req.headers.host ?? '';
  if (!isLoopbackHost(host)) {
    throw new AppError(ErrorKind.PERMISSION, '仅允许本机回环地址访问', {
      details: { host },
    });
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError(ErrorKind.PERMISSION, 'Origin 不合法');
    }
    if (originHost !== host || !isLoopbackHost(originHost)) {
      throw new AppError(ErrorKind.PERMISSION, '跨站请求被拒绝', { details: { origin } });
    }
  }

  const cookies = parseCookies(req);
  let sessionId = cookies[SESSION_COOKIE];
  let csrfToken = cookies[CSRF_COOKIE];

  if (!sessionId || !csrfToken) {
    if (MUTATING.has(req.method)) {
      throw new AppError(ErrorKind.AUTH, '本地会话缺失，请刷新页面后重试');
    }
    sessionId = sessionId || token();
    csrfToken = csrfToken || token();
    setCookie(res, SESSION_COOKIE, sessionId, { httpOnly: true });
    setCookie(res, CSRF_COOKIE, csrfToken, { httpOnly: false });
  }

  if (MUTATING.has(req.method)) {
    const provided = req.headers[CSRF_HEADER];
    if (!provided || provided !== csrfToken) {
      throw new AppError(ErrorKind.PERMISSION, 'CSRF 校验失败，请刷新页面后重试');
    }
  }

  return { sessionId, csrfToken };
}
