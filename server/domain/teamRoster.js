import { AppError, ErrorKind } from '../lib/errors.js';

/**
 * 团队名单解析（EI-monorepo `teams.yaml`）。
 *
 * 只解析这一份文件实际使用的固定形状，不做通用 YAML 实现：
 *
 *   teams:
 *     - name: Seal
 *       virtual: true            # 可选
 *       members:
 *         - { id: apxkb, bitbucketAccountId: "712020:8bb9...", name: Deon Chen }
 *
 * 刻意写窄：这份名单决定「哪些 PR 要整份评审」，宽松解析一旦把结构读错，
 * 会静默漏掉成员并让 PR 退回按 Seal 范围评审 —— 少评比多评危险。
 * 因此任何不认识的结构都抛错，由调用方如实展示，而不是当成空名单。
 */

const TEAMS_KEY = /^teams\s*:\s*$/;
const TEAM_ITEM = /^ {2}- +name\s*:\s*(.+?)\s*$/;
const TEAM_PROP = /^ {4}([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const MEMBER_ITEM = /^ {6}- +\{(.+)\}\s*$/;
/** 行内映射的字段：值可能带引号，也可能是裸字符串（`name: Deon Chen`）。 */
const INLINE_FIELD = /([A-Za-z][A-Za-z0-9_]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/g;

const unquote = (value) => value.trim().replace(/^["'](.*)["']$/, '$1').trim();

function parseMember(inline, lineNumber) {
  const member = {};
  for (const match of inline.matchAll(INLINE_FIELD)) {
    const [, key, dq, sq, bare] = match;
    member[key] = (dq ?? sq ?? bare ?? '').trim();
  }
  if (!member.bitbucketAccountId) {
    throw new AppError(ErrorKind.UPSTREAM, `teams.yaml 第 ${lineNumber} 行的成员缺少 bitbucketAccountId`, {
      remedy: '每个成员都必须带 bitbucketAccountId，否则无法与 Bitbucket 的 PR 作者对应。',
    });
  }
  return {
    id: member.id ?? null,
    accountId: member.bitbucketAccountId,
    name: member.name ?? null,
  };
}

/** @returns {{teams: Array<{name: string, virtual: boolean, members: Array<{id, accountId, name}>}>}} */
export function parseTeamsYaml(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(ErrorKind.UPSTREAM, 'teams.yaml 内容为空');
  }
  const lines = text.split(/\r?\n/);
  const teams = [];
  let current = null;
  let inMembers = false;
  let sawTeamsKey = false;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (TEAMS_KEY.test(line)) {
      sawTeamsKey = true;
      continue;
    }
    if (!sawTeamsKey) continue;

    const teamItem = TEAM_ITEM.exec(line);
    if (teamItem) {
      current = { name: unquote(teamItem[1]), virtual: false, members: [] };
      inMembers = false;
      teams.push(current);
      continue;
    }

    const member = MEMBER_ITEM.exec(line);
    if (member) {
      if (!current || !inMembers) {
        throw new AppError(ErrorKind.UPSTREAM, `teams.yaml 第 ${lineNumber} 行出现了不属于任何 members 的条目`);
      }
      current.members.push(parseMember(member[1], lineNumber));
      continue;
    }

    const prop = TEAM_PROP.exec(line);
    if (prop && current) {
      const [, key, value] = prop;
      inMembers = key === 'members';
      if (key === 'virtual') current.virtual = unquote(value) === 'true';
      continue;
    }

    // YAML 的多行折叠标量：`description:` 的续行缩进比属性本身更深。
    // 这些行不含名单信息，跳过即可，但不能当成无法识别而报错。
    if (current && !inMembers && /^ {5,}\S/.test(line)) continue;

    throw new AppError(ErrorKind.UPSTREAM, `teams.yaml 第 ${lineNumber} 行的结构无法识别：${line.trim().slice(0, 80)}`, {
      remedy: 'Sakura 只解析 teams.yaml 既有的固定写法；若上游格式变了，请同步更新解析器，不要让名单被静默读空。',
    });
  }

  if (!sawTeamsKey) {
    throw new AppError(ErrorKind.UPSTREAM, 'teams.yaml 中没有找到顶层的 teams: 列表');
  }
  return { teams };
}

/** 取指定团队；团队名大小写不敏感，但必须存在，缺失一律报错而不是当作空队。 */
export function findTeam(roster, teamName) {
  const wanted = String(teamName ?? '').trim().toLowerCase();
  const team = roster.teams.find((item) => item.name.toLowerCase() === wanted);
  if (!team) {
    throw new AppError(ErrorKind.NOT_FOUND, `teams.yaml 中没有名为 ${teamName} 的团队`, {
      remedy: `现有团队：${roster.teams.map((item) => item.name).join('、') || '（空）'}`,
    });
  }
  return team;
}
