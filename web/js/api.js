/** 本地 API 客户端：变更请求携带 CSRF token；Token 类凭据只单向提交，不在前端持久化。 */

const readCookie = (name) =>
  document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.error?.message ?? `请求失败（${status}）`);
    this.kind = payload?.error?.kind ?? 'internal';
    this.details = payload?.error?.details ?? null;
    this.remedy = payload?.error?.remedy ?? null;
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const csrf = readCookie('sakura_csrf');
  if (csrf) headers['x-sakura-csrf'] = decodeURIComponent(csrf);

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(payload, response.status);
  return payload;
}

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  connectionStatus: () => request('GET', '/api/connection/status'),
  identities: () => request('GET', '/api/connection/identities'),
  models: () => request('GET', '/api/connection/models'),
  addModel: (model) => request('POST', '/api/connection/models', model),
  verifyModel: (id) => request('POST', '/api/connection/models/verify', { id }),
  removeModel: (id) => request('DELETE', `/api/connection/models/${encodeURIComponent(id)}`),
  testConnection: (target) => request('POST', '/api/connection/test', { target }),
  saveCredential: (name, token) => request('POST', '/api/connection/credential', { name, token }),
  removeCredential: (name) => request('DELETE', `/api/connection/credential/${name}`),
  saveSetting: (key, value) => request('PUT', '/api/settings', { key, value }),
  saveModel: (model) => request('PUT', '/api/settings/model', model),

  prs: () => request('GET', '/api/prs'),
  syncPrs: () => request('POST', '/api/prs/sync'),
  preflight: (prId) => request('GET', `/api/prs/${encodeURIComponent(prId)}/preflight`),
  diff: (prId) => request('GET', `/api/prs/${encodeURIComponent(prId)}/diff`),
  rounds: (prId) => request('GET', `/api/prs/${encodeURIComponent(prId)}/rounds`),
  startReview: (prId, payload = {}) =>
    request('POST', `/api/prs/${encodeURIComponent(prId)}/review`, payload),

  round: (roundId) => request('GET', `/api/rounds/${roundId}`),
  saveJiraKeys: (prId, keys) =>
    request('PUT', `/api/prs/${encodeURIComponent(prId)}/jira-keys`, { keys }),
  setCarryoverVerdict: (id, verdict, note) =>
    request('PATCH', `/api/carryover/${id}`, { verdict, note }),
  gitCache: () => request('GET', '/api/git-cache'),
  clearGitCache: (confirm) => request('POST', '/api/git-cache/clear', { confirm }),
  knowledgeBase: () => request('GET', '/api/knowledge-base'),
  refreshKnowledgeBase: () => request('POST', '/api/knowledge-base/refresh', {}),
  cancelRound: (roundId) => request('POST', `/api/rounds/${roundId}/cancel`, {}),
  updateSummary: (roundId, patch) => request('PATCH', `/api/rounds/${roundId}/summary`, patch),
  updateFinding: (findingId, patch) => request('PATCH', `/api/findings/${findingId}`, patch),
  publishPreview: (roundId, action) =>
    request('POST', `/api/rounds/${roundId}/publish/preview`, { action }),
  publish: (roundId, action) => request('POST', `/api/rounds/${roundId}/publish`, { action }),

  history: () => request('GET', '/api/history'),
  audit: () => request('GET', '/api/audit'),
};
