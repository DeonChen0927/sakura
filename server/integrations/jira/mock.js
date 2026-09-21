import { AppError, ErrorKind } from '../../lib/errors.js';
import { MOCK_JIRA_ISSUES } from '../bitbucket/mockData.js';

/** Jira 演示适配器：返回本地构造的需求与验收标准，不访问真实实例。 */
export function createMockJiraClient() {
  return {
    mode: 'mock',

    async testConnection() {
      return { ok: true, demo: true, detail: '演示模式：未连接真实 Jira 实例。' };
    },

    async getIssue(key) {
      const issue = MOCK_JIRA_ISSUES[key];
      if (!issue) {
        throw new AppError(ErrorKind.NOT_FOUND, `演示数据中不存在 Jira ${key}`);
      }
      return structuredClone(issue);
    },
  };
}
