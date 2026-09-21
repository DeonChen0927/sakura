import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTeamSealScope } from '../server/domain/teamSeal.js';

// 真实来源：Bitbucket Codeowner Bot 的评论（已脱敏），一条评论里串了多个团队区块。
const BOT_COMMENT = `Bleep! I am here to help you pick the right reviewers for this pull request.


~~

A review from team **Seal** (@{712020:aaaa}, @{712020:bbbb}) is required due to changes in:

* \`/example-service/server/com.example.service.api/src/main/java/com/example/service/services/conference/\`
* \`/example-service/server/com.example.service/src/test/java/com/example/service/services/conference/\`

:white_check_mark: Good! @{712020:bbbb} is already selected as reviewer.

~~

A review from team **Meerkat** (@{5cd18092}) is required due to changes in:

* \`/example-service/server/com.example.service/src/main/java/com/example/service/workflow/\`

~~

Info: The assignment is according to the \`functional-areas.yaml\` file.`;

const FILES = [
  { path: 'example-service/server/com.example.service.api/src/main/java/com/example/service/services/conference/ConferenceService.java' },
  { path: 'example-service/server/com.example.service/src/test/java/com/example/service/services/conference/ConferenceServiceTest.java' },
  { path: 'example-service/server/com.example.service/src/main/java/com/example/service/workflow/WorkflowOp.java' },
];

test('从机器人评论识别 Team Seal 范围，粗体团队名与根路径写法都要认', () => {
  const scope = resolveTeamSealScope(
    [
      { text: '', origin: 'description' },
      { text: BOT_COMMENT, origin: 'comment:1' },
    ],
    FILES,
  );

  assert.equal(scope.ok, true, JSON.stringify(scope.warnings));
  assert.equal(scope.fallback, null);
  assert.equal(scope.origin, 'comment:1');
  assert.equal(scope.entries.length, 2);
  assert.deepEqual(
    scope.inScopeFiles.sort(),
    [FILES[0].path, FILES[1].path].sort(),
  );
});

test('同一条评论里其他团队的范围不能算进 Seal', () => {
  const scope = resolveTeamSealScope([{ text: BOT_COMMENT, origin: 'comment:1' }], FILES);
  assert.ok(!scope.inScopeFiles.includes(FILES[2].path));
  assert.ok(scope.outOfScopeFiles.includes(FILES[2].path));
});

test('描述和评论都没有标记时不阻断，回退为评审全部变更并给出警告', () => {
  const scope = resolveTeamSealScope(
    [
      { text: 'just a description', origin: 'description' },
      { text: 'LGTM', origin: 'comment:9' },
    ],
    FILES,
  );
  assert.equal(scope.ok, true);
  assert.equal(scope.blockers.length, 0);
  assert.equal(scope.fallback, 'all_changes');
  assert.deepEqual(scope.inScopeFiles, FILES.map((file) => file.path).sort());
  assert.deepEqual(scope.outOfScopeFiles, []);
  assert.equal(scope.warnings[0].code, 'scope_marker_missing');
  assert.match(scope.warnings[0].remedy, /Codeowner Bot/);
});

test('标记存在但条目全部落空时也回退为全部变更', () => {
  const scope = resolveTeamSealScope(
    [
      {
        text: 'A review from team **Seal** is required due to changes in:\n\n* `/no/such/path/`\n',
        origin: 'comment:1',
      },
    ],
    FILES,
  );
  assert.equal(scope.ok, true);
  assert.equal(scope.fallback, 'all_changes');
  assert.deepEqual(scope.inScopeFiles, FILES.map((file) => file.path).sort());
  assert.ok(scope.warnings.some((item) => item.code === 'scope_no_files'));
});
