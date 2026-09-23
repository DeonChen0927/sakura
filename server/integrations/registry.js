import { createMockBitbucketClient } from './bitbucket/mock.js';
import { createLiveBitbucketClient } from './bitbucket/live.js';
import { createMockJiraClient } from './jira/mock.js';
import { createLiveJiraClient } from './jira/live.js';
import { createMockCopilotClient } from './copilot/mock.js';
import { createLiveCopilotClient } from './copilot/live.js';
import { credentialStore } from '../security/credentialStore.js';
import { settingsService, SettingKey } from '../services/settingsService.js';

export const CredentialName = {
  BITBUCKET: 'bitbucket.token',
  JIRA: 'jira.token',
  // Copilot CLI 的认证凭据：CLI 自身登录态不可用时，由 Sakura 注入 COPILOT_GITHUB_TOKEN，
  // 避免「换个终端启动服务就报未认证」。
  COPILOT: 'copilot.token',
};

let cache = { mode: null, clients: null };

/**
 * 集成注册表：按设置在演示适配器与真实适配器之间切换。
 * 演示模式明确标记 demo，不冒充真实连接（FR-01 / AC21）。
 */
export function getClients({ force = false } = {}) {
  const mode = settingsService.integrationMode();
  if (!force && cache.mode === mode && cache.clients) return cache.clients;

  const clients =
    mode === 'live'
      ? {
          mode,
          demo: false,
          bitbucket: createLiveBitbucketClient({
            ...settingsService.get(SettingKey.BITBUCKET),
            getToken: () => credentialStore.get(CredentialName.BITBUCKET),
          }),
          jira: createLiveJiraClient({
            ...settingsService.get(SettingKey.JIRA),
            getToken: () => credentialStore.get(CredentialName.JIRA),
          }),
          copilot: createLiveCopilotClient({
            binary: settingsService.get(SettingKey.COPILOT_BINARY),
            getModelCatalog: () => settingsService.modelCatalog(),
            getToken: () => credentialStore.get(CredentialName.COPILOT),
          }),
        }
      : {
          mode,
          demo: true,
          bitbucket: createMockBitbucketClient(),
          jira: createMockJiraClient(),
          copilot: createMockCopilotClient(),
        };

  cache = { mode, clients };
  return clients;
}

export function resetClients() {
  cache = { mode: null, clients: null };
}
