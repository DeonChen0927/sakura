import fs from 'node:fs';
import path from 'node:path';
import { parseTeamsYaml, findTeam } from '../domain/teamRoster.js';
import { settingsService, SettingKey } from './settingsService.js';

/**
 * Team Seal 成员名单（FR-03）。
 *
 * 名单来自 EI-monorepo 的 `teams.yaml`，只读本机文件，不联网。
 * 名单决定「哪些 PR 整份评审」，因此读取失败必须如实上报：
 * 静默当成空名单会让本该整份评审的 PR 退回按 Seal 范围评审，属于漏评。
 */

const ROSTER_FILE = 'teams.yaml';
let cache = null;

function resolvePath() {
  const configured = String(settingsService.get(SettingKey.TEAM_ROSTER)?.path ?? '').trim();
  if (configured) return { path: path.resolve(configured), explicit: true };
  // 未单独配置时沿用 Git 缓存里已填的本机仓库路径：teams.yaml 就在那个仓库根目录。
  const localSource = String(
    settingsService.get(SettingKey.GIT_CACHE)?.localSourcePath ?? '',
  ).trim();
  if (localSource) return { path: path.resolve(localSource, ROSTER_FILE), explicit: false };
  return { path: null, explicit: false };
}

export const teamRosterService = {
  teamName() {
    return String(settingsService.get(SettingKey.TEAM_ROSTER)?.team ?? 'Seal').trim() || 'Seal';
  },

  /**
   * 读取名单。按文件路径 + mtime 缓存：teams.yaml 改动后无需重启，
   * 但一次评审流程里的多次调用不会重复读盘。
   */
  load() {
    const teamName = this.teamName();
    const { path: file, explicit } = resolvePath();
    if (!file) {
      return {
        configured: false,
        ok: false,
        path: null,
        team: teamName,
        members: [],
        detail:
          '未配置 teams.yaml 路径，也没有填写本机仓库路径，无法判断 PR 作者是否为团队成员。',
        remedy: '请在「连接设置 → 团队名单」填写 teams.yaml 路径，或填写本机 EI-monorepo 仓库路径。',
      };
    }

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return {
        configured: true,
        ok: false,
        path: file,
        team: teamName,
        members: [],
        detail: explicit
          ? `配置的 teams.yaml 不存在：${file}`
          : `本机仓库路径下没有 ${ROSTER_FILE}：${file}`,
        remedy: '请确认路径指向 EI-monorepo 仓库根目录，或在团队名单里直接填写 teams.yaml 的完整路径。',
      };
    }

    const key = `${file}@${stat.mtimeMs}@${teamName}`;
    if (cache?.key === key) return cache.value;

    let value;
    try {
      const team = findTeam(parseTeamsYaml(fs.readFileSync(file, 'utf8')), teamName);
      value = {
        configured: true,
        ok: true,
        path: file,
        team: team.name,
        members: team.members,
        detail: `已载入 ${team.name} 团队 ${team.members.length} 名成员。`,
      };
    } catch (error) {
      value = {
        configured: true,
        ok: false,
        path: file,
        team: teamName,
        members: [],
        detail: error.message,
        remedy: error.remedy ?? '请确认 teams.yaml 内容完整且格式未变。',
      };
    }
    cache = { key, value };
    return value;
  },

  /**
   * 判断某个 Bitbucket 账号是否为团队成员。
   * 只用 account_id 比对：显示名会改，UUID 与 teams.yaml 记的不是同一个标识。
   */
  isMember(accountId) {
    const roster = this.load();
    if (!roster.ok || !accountId) return { ok: roster.ok, member: null, roster };
    const member = roster.members.find((item) => item.accountId === accountId) ?? null;
    return { ok: true, member, roster };
  },

  invalidate() {
    cache = null;
  },
};
