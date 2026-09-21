import { settingsRepo } from '../db/repositories/settingsRepo.js';
import { config } from '../config.js';
import { validationError } from '../lib/errors.js';

export const SettingKey = {
  REPOSITORY: 'connection.repository',
  INTEGRATION_MODE: 'connection.integrationMode',
  BITBUCKET: 'connection.bitbucket',
  JIRA: 'connection.jira',
  COPILOT_BINARY: 'copilot.binary',
  REVIEW_MODEL: 'copilot.reviewModel',
  MODEL_CATALOG: 'copilot.modelCatalog',
  DRAFT_POLICY: 'review.draftPolicy',
  MANUAL_JIRA_KEYS: 'review.manualJiraKeys',
  GIT_CACHE: 'review.gitCache',
};

const DEFAULTS = {
  [SettingKey.REPOSITORY]: config.defaultRepository,
  [SettingKey.INTEGRATION_MODE]: config.integrationMode,
  // 默认 auto：只录入 token 即可用 —— 先试 Bearer（访问令牌 / PAT / OAuth），
  // 401 且填了邮箱时再退回 Basic（Atlassian API token）。也可显式锁定某一种。
  [SettingKey.BITBUCKET]: {
    authScheme: 'auto',
    email: '',
    apiBase: 'https://api.bitbucket.org/2.0',
    includeDrafts: true,
  },
  [SettingKey.JIRA]: { baseUrl: '', email: '', authScheme: 'auto', acceptanceFieldId: '' },
  [SettingKey.COPILOT_BINARY]: 'copilot',
  [SettingKey.REVIEW_MODEL]: null,
  // CLI 不提供模型枚举（实测 1.0.84），目录由用户维护，可用性靠真实探测写回。
  [SettingKey.MODEL_CATALOG]: [],
  [SettingKey.DRAFT_POLICY]: { allowReview: true, allowStatefulPublish: false },
  [SettingKey.MANUAL_JIRA_KEYS]: {},
  [SettingKey.GIT_CACHE]: {
    enabled: true,
    // 只读远端地址，绝不写入 Token（FR-07 架构约束 / AC15）
    remoteUrlTemplate: 'https://bitbucket.org/{repository}.git',
    maxContextFiles: 8,
    // 本机已有的仓库克隆，优先作为只读上下文来源：只执行 cat-file/show，
    // 不 fetch、不 checkout、不改动该目录的任何状态。留空表示只用网络缓存。
    localSourcePath: '',
  },
};

/**
 * 认证方式归一：早期版本默认 basic，但没有邮箱的 basic 永远不可能成功。
 * 这种组合直接当作 auto（先试 Bearer），避免用户为了用一个 token 还要去改下拉框。
 */
function normalize(key, value) {
  if (key !== SettingKey.BITBUCKET && key !== SettingKey.JIRA) return value;
  if (!value || typeof value !== 'object') return value;
  const authScheme = value.authScheme === 'basic' && !value.email ? 'auto' : value.authScheme ?? 'auto';
  return { ...value, authScheme };
}

export const settingsService = {
  get(key) {
    const value = settingsRepo.get(key, undefined);
    return normalize(key, value === undefined || value === null ? DEFAULTS[key] : value);
  },

  set(key, value) {
    if (!Object.values(SettingKey).includes(key)) throw validationError(`未知设置项：${key}`);
    return settingsRepo.set(key, value);
  },

  /**
   * 评审模型是用户级默认值（FR-11 / AC23）。
   * 仅首次未配置时采用默认 Claude Opus 5；已保存但损坏的配置必须提示修正，不静默重置。
   */
  getReviewModel() {
    const stored = settingsRepo.get(SettingKey.REVIEW_MODEL, undefined);
    if (stored === undefined || stored === null) {
      return { ...config.defaultModel, source: 'default' };
    }
    if (!stored.id || !stored.name) {
      return { invalid: true, stored, source: 'stored' };
    }
    return { id: stored.id, name: stored.name, source: 'stored' };
  },

  setReviewModel(model) {
    if (!model?.id || !model?.name) throw validationError('模型配置必须包含 id 与显示名称');
    settingsRepo.set(SettingKey.REVIEW_MODEL, { id: model.id, name: model.name });
    return this.getReviewModel();
  },

  /** 模型目录：CLI 无法枚举模型，所以由用户登记；每项记录最近一次真实探测结果。 */
  modelCatalog() {
    const stored = this.get(SettingKey.MODEL_CATALOG);
    return Array.isArray(stored) ? stored.filter((entry) => entry?.id) : [];
  },

  addModelToCatalog({ id, name } = {}) {
    const modelId = String(id ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)) {
      throw validationError('模型 ID 只能包含字母、数字、点、下划线与连字符');
    }
    const catalog = this.modelCatalog();
    if (catalog.some((entry) => entry.id === modelId)) {
      throw validationError(`模型已存在：${modelId}`);
    }
    catalog.push({ id: modelId, name: String(name ?? '').trim() || modelId, check: null });
    settingsRepo.set(SettingKey.MODEL_CATALOG, catalog);
    return catalog;
  },

  removeModelFromCatalog(id) {
    const catalog = this.modelCatalog().filter((entry) => entry.id !== id);
    settingsRepo.set(SettingKey.MODEL_CATALOG, catalog);
    return catalog;
  },

  recordModelCheck(id, check) {
    const catalog = this.modelCatalog();
    const entry = catalog.find((item) => item.id === id);
    if (!entry) throw validationError(`模型不在目录中：${id}`);
    entry.check = { status: check.status, detail: check.detail ?? null, checkedAt: new Date().toISOString() };
    settingsRepo.set(SettingKey.MODEL_CATALOG, catalog);
    return entry;
  },

  integrationMode() {
    return this.get(SettingKey.INTEGRATION_MODE) === 'live' ? 'live' : 'mock';
  },

  repository() {
    return this.get(SettingKey.REPOSITORY);
  },

  /** 人工补充的 Jira key 按 PR 持久化，刷新与重启后仍然可见（FR-04）。 */
  manualJiraKeys(prId) {
    const map = this.get(SettingKey.MANUAL_JIRA_KEYS) ?? {};
    return Array.isArray(map[prId]) ? map[prId] : [];
  },

  setManualJiraKeys(prId, keys) {
    if (!Array.isArray(keys)) throw validationError('Jira key 列表必须是数组');
    const normalized = [
      ...new Set(
        keys
          .map((key) => String(key).trim().toUpperCase())
          .filter((key) => /^[A-Z][A-Z0-9]+-\d+$/.test(key)),
      ),
    ];
    if (normalized.length !== keys.length) {
      throw validationError('存在无法识别的 Jira key，请使用 ABC-123 形式');
    }
    const map = { ...(this.get(SettingKey.MANUAL_JIRA_KEYS) ?? {}) };
    if (normalized.length) map[prId] = normalized;
    else delete map[prId];
    settingsRepo.set(SettingKey.MANUAL_JIRA_KEYS, map);
    return normalized;
  },

  all() {
    const out = {};
    for (const key of Object.values(SettingKey)) out[key] = this.get(key);
    return out;
  },
};
