import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-test-'));
process.env.SAKURA_INTEGRATION_MODE = 'mock';

const { parseTeamsYaml, findTeam } = await import('../server/domain/teamRoster.js');
const { prService } = await import('../server/services/prService.js');
const { settingsService, SettingKey } = await import('../server/services/settingsService.js');
const { teamRosterService } = await import('../server/services/teamRosterService.js');
const { closeDb } = await import('../server/db/database.js');

const ROSTER = `# comment
teams:
  - name: Meerkat
    members:
      - { id: axozc, bitbucketAccountId: "557058:07137555", name: Asma Ouji }
  - name: Seal
    members:
      - { id: apxkb, bitbucketAccountId: "712020:8bb977c5", name: Deon Chen }
      - { id: apysx, bitbucketAccountId: "712020:d96bd41d", name: Vicky Xue }
  - name: XERO
    virtual: true
    description: Virtual team for XERO client related items.  Please use actual scrum
      teams where possible.
    members:
      - { id: amify, bitbucketAccountId: "5b2ab5e1", name: Rob Lowe }
`;

const rosterFile = path.join(process.env.SAKURA_DATA_DIR, 'teams.yaml');
fs.writeFileSync(rosterFile, ROSTER, 'utf8');

const DIFF = [{ path: 'a/One.java' }, { path: 'b/Two.java' }, { path: 'c/Three.java' }];
const SCOPE_COMMENT = {
  id: '1',
  body: 'A review from team **Seal** (@x) is required due to changes in:\n\n* `/a/`\n',
};
const clientsStub = { bitbucket: { listComments: async () => [SCOPE_COMMENT] } };

test.after(() => {
  // 只关数据库：日志写入流在进程存活期间一直开着，这里删目录会和它抢，
  // 反而让测试报出无关的 ENOENT。临时目录交给操作系统回收。
  closeDb();
});

test('解析 teams.yaml 的固定写法，包含 virtual 与多行 description', () => {
  const roster = parseTeamsYaml(ROSTER);
  assert.equal(roster.teams.length, 3);
  const seal = findTeam(roster, 'seal');
  assert.deepEqual(
    seal.members.map((member) => member.accountId),
    ['712020:8bb977c5', '712020:d96bd41d'],
  );
  assert.equal(findTeam(roster, 'XERO').virtual, true);
});

test('结构无法识别时抛错，不把名单静默读成空', () => {
  assert.throws(() => parseTeamsYaml('teams:\n  - name: Seal\n    members:\n      - id: oops\n'), /无法识别/);
  assert.throws(() => parseTeamsYaml('nothing: here\n'), /没有找到顶层的 teams/);
});

test('我本人发起的 PR 按全部变更评审，忽略 Team Seal 范围标记', async () => {
  settingsService.set(SettingKey.TEAM_ROSTER, { path: rosterFile, team: 'Seal' });
  teamRosterService.invalidate();

  const scope = await prService.resolveScope(
    clientsStub,
    { authoredByMe: true, author: { accountId: 'someone-else' }, description: '' },
    DIFF,
  );
  assert.equal(scope.policy, 'author_is_me');
  assert.equal(scope.fallback, null);
  assert.deepEqual(scope.inScopeFiles, ['a/One.java', 'b/Two.java', 'c/Three.java']);
});

test('Seal 成员发起的 PR 按全部变更评审，忽略 Team Seal 范围标记', async () => {
  settingsService.set(SettingKey.TEAM_ROSTER, { path: rosterFile, team: 'Seal' });
  teamRosterService.invalidate();

  const scope = await prService.resolveScope(
    clientsStub,
    { authoredByMe: false, author: { accountId: '712020:d96bd41d', name: 'Vicky Xue' }, description: '' },
    DIFF,
  );
  assert.equal(scope.policy, 'author_in_team');
  assert.equal(scope.inScopeFiles.length, 3);
  assert.match(scope.reason, /Vicky Xue/);
});

test('非团队成员发起的 PR 仍按 Team Seal 范围评审', async () => {
  settingsService.set(SettingKey.TEAM_ROSTER, { path: rosterFile, team: 'Seal' });
  teamRosterService.invalidate();

  const scope = await prService.resolveScope(
    clientsStub,
    { authoredByMe: false, author: { accountId: '557058:07137555', name: 'Asma Ouji' }, description: '' },
    DIFF,
  );
  assert.equal(scope.policy, 'team_scope');
  assert.deepEqual(scope.inScopeFiles, ['a/One.java']);
});

test('名单不可用时回退到 Team Seal 范围，并明确警告可能漏评', async () => {
  settingsService.set(SettingKey.TEAM_ROSTER, {
    path: path.join(process.env.SAKURA_DATA_DIR, 'missing.yaml'),
    team: 'Seal',
  });
  teamRosterService.invalidate();

  const scope = await prService.resolveScope(
    clientsStub,
    { authoredByMe: false, author: { accountId: '712020:d96bd41d' }, description: '' },
    DIFF,
  );
  assert.equal(scope.policy, 'team_scope');
  assert.deepEqual(scope.inScopeFiles, ['a/One.java']);
  const warning = scope.warnings.find((item) => item.code === 'team_roster_unavailable');
  assert.ok(warning, JSON.stringify(scope.warnings));
  assert.match(warning.message, /无法读取/);
});
