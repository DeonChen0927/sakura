import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-sync-'));
process.env.SAKURA_INTEGRATION_MODE = 'mock';

const { prService } = await import('../server/services/prService.js');
const { prRepo } = await import('../server/db/repositories/prRepo.js');
const { roundRepo } = await import('../server/db/repositories/roundRepo.js');
const { settingsService } = await import('../server/services/settingsService.js');
const { closeDb } = await import('../server/db/database.js');
const { run } = await import('../server/db/database.js');

test.after(async () => {
  closeDb();
  // 日志是异步写入的，等它落盘再删临时目录，否则会在测试结束后抛 ENOENT。
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(process.env.SAKURA_DATA_DIR, { recursive: true, force: true });
});

const repository = settingsService.repository();

const stale = (number, title) => ({
  repository,
  number,
  title,
  description: '',
  author: { name: '某人', id: 'x' },
  sourceBranch: 'a',
  targetBranch: 'b',
  sourceCommit: 'c1',
  targetCommit: 'c2',
  lifecycleState: 'MERGED',
  isDraft: false,
  myReviewState: 'none',
  updatedAt: new Date().toISOString(),
});

/** 远端不再列为待我评审的快照，不能继续冒充待办（例如已合并、或我根本不是评审人）。 */
test('同步会清掉远端不再列出的陈旧快照', async () => {
  const ghost = prRepo.upsert(stale(9999, '已合并且与我无关的 PR'));
  assert.ok(prRepo.byId(ghost.id));

  const result = await prService.sync();

  assert.ok(!prRepo.byId(ghost.id), '陈旧快照应当被删除');
  assert.ok(!result.items.some((pr) => pr.number === 9999));
  assert.ok(result.items.length > 0);
});

/** 有本地评审痕迹的快照要留在库里供历史查看，但必须退出工作台列表。 */
test('远端不再列出的快照归档而不是删除', async () => {
  const tracked = prRepo.upsert(stale(9998, '评过但已被移出评审人的 PR'));
  roundRepo.create({
    pullRequestId: tracked.id,
    roundNumber: 1,
    model: { id: 'claude-opus-5', name: 'Claude Opus 5' },
    sourceCommit: 'c1',
    targetCommit: 'c2',
    inputFingerprint: 'fp',
    integrationMode: 'mock',
  });

  const result = await prService.sync();

  assert.ok(!result.items.some((pr) => pr.number === 9998), '归档后不再出现在工作台列表');
  const row = prRepo.byId(tracked.id);
  assert.ok(row, '行必须保留，否则评审历史会跟着消失');
  assert.ok(row.archivedAt);
  assert.equal(row.remoteMissing, true);
  assert.equal(roundRepo.listByPr(tracked.id).length, 1, '历史轮次不能被删掉');
});

/** 进程重启会杀掉 CLI 子进程，数据库里的运行中轮次必须如实标记为中断。 */
test('服务启动时把遗留的运行中轮次标记为已取消', async () => {
  const { reviewService } = await import('../server/services/reviewService.js');
  const pr = prRepo.upsert(stale(9997, '重启时正在评审的 PR'));
  const round = roundRepo.create({
    pullRequestId: pr.id,
    roundNumber: 1,
    status: 'running',
    model: { id: 'claude-opus-5', name: 'Claude Opus 5' },
    sourceCommit: 'c1',
    targetCommit: 'c2',
    inputFingerprint: 'fp',
    integrationMode: 'mock',
  });

  const count = reviewService.reconcileOrphanRounds();

  assert.ok(count >= 1);
  const after = roundRepo.byId(round.id);
  assert.equal(after.status, 'cancelled');
  assert.match(after.statusReason, /服务重启/);
  assert.equal(roundRepo.listActive().length, 0);
});
/** 你本人已在 Bitbucket 表态时，本地挂着的「待你确认」不该继续占用待办。 */
test('远端已 Approved 时自动完结本地未确认轮次', async () => {
  const pr = prRepo.upsert({
    ...stale(9996, '远端已 approve 的 PR'),
    lifecycleState: 'OPEN',
    myReviewState: 'approved',
  });
  const round = roundRepo.create({
    pullRequestId: pr.id,
    roundNumber: 1,
    status: 'awaiting_confirmation',
    model: { id: 'claude-opus-5', name: 'Claude Opus 5' },
    sourceCommit: 'c1',
    targetCommit: 'c2',
    inputFingerprint: 'fp',
    integrationMode: 'mock',
  });

  const closed = prService.closeRoundsSettledRemotely(prRepo.byId(pr.id));

  assert.equal(closed.status, 'closed_remote');
  assert.match(closed.statusReason, /Approved/);
  assert.ok(roundRepo.byId(round.id).finishedAt, '自动完结要写入结束时间');
  assert.equal(prService.localState(prRepo.byId(pr.id), roundRepo.byId(round.id)), 'closed_remote');
});

/** 远端还没表态时不能擅自结束轮次，否则等于替用户确认。 */
test('远端未表态时不动本地轮次', async () => {
  const pr = prRepo.upsert({ ...stale(9995, '远端未表态的 PR'), lifecycleState: 'OPEN' });
  const round = roundRepo.create({
    pullRequestId: pr.id,
    roundNumber: 1,
    status: 'awaiting_confirmation',
    model: { id: 'claude-opus-5', name: 'Claude Opus 5' },
    sourceCommit: 'c1',
    targetCommit: 'c2',
    inputFingerprint: 'fp',
    integrationMode: 'mock',
  });

  assert.equal(prService.closeRoundsSettledRemotely(prRepo.byId(pr.id)), null);
  assert.equal(roundRepo.byId(round.id).status, 'awaiting_confirmation');
});

/** 历史无限增长会拖慢本机工具，上限 100 轮，超出的直接删除。 */
test('评审历史超过 100 条时删除最旧的记录', async () => {
  const pr = prRepo.upsert({ ...stale(9994, '评审很多轮的 PR'), lifecycleState: 'OPEN' });
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 105; i += 1) {
    const round = roundRepo.create({
      pullRequestId: pr.id,
      roundNumber: i + 1,
      status: 'cancelled',
      model: { id: 'claude-opus-5', name: 'Claude Opus 5' },
      sourceCommit: 'c1',
      targetCommit: 'c2',
      inputFingerprint: 'fp',
      integrationMode: 'mock',
    });
    // 逐条拉开时间，确保“最旧的被删”这件事可验证。
    run(
      'UPDATE review_rounds SET started_at = ? WHERE id = ?',
      new Date(base + i * 60000).toISOString(),
      round.id,
    );
  }

  const before = roundRepo.listAll(1000).length;
  const removed = roundRepo.pruneHistory();

  assert.equal(removed, before - 100);
  assert.equal(roundRepo.listAll(1000).length, 100);
  const left = roundRepo.listByPr(pr.id);
  assert.ok(!left.some((round) => round.roundNumber <= 5), '删掉的必须是最旧的几轮');
});

test('远端重新列出时撤销标记', async () => {  const listed = (await prService.sync()).items.find((pr) => !pr.remoteMissing);
  prRepo.markMissing(listed.id, true);
  assert.equal(prRepo.byId(listed.id).remoteMissing, true);

  const result = await prService.sync();
  const row = result.items.find((pr) => pr.id === listed.id);

  assert.equal(row.remoteMissing, false);
  assert.equal(row.remoteMissingAt, null);
});
