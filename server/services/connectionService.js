import { getClients, CredentialName } from '../integrations/registry.js';
import { credentialStore, credentialBackend } from '../security/credentialStore.js';
import { settingsService, SettingKey } from './settingsService.js';
import { teamRosterService } from './teamRosterService.js';
import { knowledgeBaseService } from './knowledgeBaseService.js';
import { auditRepo } from '../db/repositories/auditRepo.js';
import { AppError, ErrorKind } from '../lib/errors.js';
import { config } from '../config.js';

const describeError = (error) => ({
  ok: false,
  kind: error instanceof AppError ? error.kind : 'internal',
  detail: error.message,
  remedy: error instanceof AppError ? error.remedy : null,
});

/**
 * 连接与身份（FR-01）：分别展示 Bitbucket 与 Copilot 的实际登录身份，
 * 连接测试区分网络/认证/权限/限流，不显示伪成功。
 */
export const connectionService = {
  async status() {
    const clients = getClients();
    const model = settingsService.getReviewModel();

    return {
      mode: clients.mode,
      demo: clients.demo,
      repository: settingsService.repository(),
      credentialBackend,
      credentials: {
        bitbucket: credentialStore.status(CredentialName.BITBUCKET),
        jira: credentialStore.status(CredentialName.JIRA),
        copilot: credentialStore.status(CredentialName.COPILOT),
      },
      jira: { ...settingsService.get(SettingKey.JIRA), token: undefined },
      bitbucket: { ...settingsService.get(SettingKey.BITBUCKET), token: undefined },
      copilotBinary: settingsService.get(SettingKey.COPILOT_BINARY),
      reviewModel: model,
      defaultModel: config.defaultModel,
      draftPolicy: settingsService.get(SettingKey.DRAFT_POLICY),
      // 名单决定哪些 PR 整份评审，读不到必须在设置页直接看见，而不是等到前置检查才发现。
      teamRoster: (() => {
        const roster = teamRosterService.load();
        return {
          ...roster,
          settings: settingsService.get(SettingKey.TEAM_ROSTER),
          memberCount: roster.members.length,
          members: undefined,
        };
      })(),
      // 知识库不可用会阻断评审，同样必须在设置页直接可见（FR-12）。
      knowledgeBase: await knowledgeBaseService.ensure(),
    };
  },

  async test(target) {
    const clients = getClients();
    const client = clients[target];
    if (!client) throw new AppError(ErrorKind.VALIDATION, `未知连接目标：${target}`);
    try {
      const result = await client.testConnection();
      auditRepo.record('user', 'connection.test', target, { ok: true, mode: clients.mode });
      return { target, ...result };
    } catch (error) {
      auditRepo.record('user', 'connection.test', target, { ok: false, kind: error?.kind });
      return { target, ...describeError(error) };
    }
  },

  async identities() {
    const clients = getClients();
    const out = { mode: clients.mode, demo: clients.demo };
    try {
      out.bitbucket = await clients.bitbucket.getCurrentUser();
    } catch (error) {
      out.bitbucket = describeError(error);
    }
    try {
      out.copilot = await clients.copilot.getIdentity();
    } catch (error) {
      out.copilot = describeError(error);
    }
    return out;
  },

  /**
   * 模型列表来自实际适配器。live 模式下 CLI 不提供枚举命令（已实测），
   * 因此列表是用户维护的目录 + 真实探测结果，不返回硬编码的“可用模型”。
   */
  async models() {
    const clients = getClients();
    const source = clients.copilot.modelSource ?? null;
    try {
      return { ok: true, demo: clients.demo, source, models: await clients.copilot.listModels() };
    } catch (error) {
      return { ...describeError(error), demo: clients.demo, source, models: [] };
    }
  },

  /** 登记一个模型 ID；CLI 无法枚举，只能由用户提供后再真实验证。 */
  async addModel({ id, name }) {
    settingsService.addModelToCatalog({ id, name });
    auditRepo.record('user', 'model.add', id);
    return this.verifyModel(id);
  },

  removeModel(id) {
    settingsService.removeModelFromCatalog(id);
    auditRepo.record('user', 'model.remove', id);
    return { ok: true, id };
  },

  /** 真实调用本机 CLI 判定模型是否被接受；结果写回目录，界面据此显示。 */
  async verifyModel(id) {
    const clients = getClients();
    if (typeof clients.copilot.verifyModel !== 'function') {
      throw new AppError(ErrorKind.PRECONDITION, '当前适配器不支持模型验证');
    }
    try {
      const check = await clients.copilot.verifyModel(id);
      settingsService.recordModelCheck(id, check);
      auditRepo.record('user', 'model.verify', id, { status: check.status });
      return { ok: true, demo: clients.demo, check, models: await clients.copilot.listModels() };
    } catch (error) {
      auditRepo.record('user', 'model.verify', id, { ok: false, kind: error?.kind });
      return { ...describeError(error), demo: clients.demo, models: await clients.copilot.listModels() };
    }
  },

  async saveCredential(name, token) {
    if (!Object.values(CredentialName).includes(name)) {
      throw new AppError('validation', `未知凭据名称：${name}`);
    }
    await credentialStore.set(name, token);
    auditRepo.record('user', 'credential.save', name, { backend: credentialBackend });
    return credentialStore.status(name);
  },

  removeCredential(name) {
    credentialStore.remove(name);
    auditRepo.record('user', 'credential.remove', name);
    return credentialStore.status(name);
  },
};
