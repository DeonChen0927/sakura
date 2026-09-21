import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-gitctx-'));
process.env.SAKURA_INTEGRATION_MODE = 'live';

const { gitCacheService } = await import('../server/services/gitCacheService.js');
const { settingsService, SettingKey } = await import('../server/services/settingsService.js');
const { buildReviewPrompt } = await import('../server/domain/prompt.js');
const { closeDb } = await import('../server/db/database.js');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-src-'));
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();

git('init', '--quiet', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello context\n');
git('add', 'a.txt');
git('commit', '--quiet', '-m', 'init');
const fullSha = git('rev-parse', 'HEAD');
const shortSha = fullSha.slice(0, 12);

test.after(async () => {
  closeDb();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(process.env.SAKURA_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

/** 本机已有克隆优先：命中即用，不做任何网络访问，也不改动该仓库。 */
test('本机仓库命中提交时直接作为只读上下文来源', async () => {
  settingsService.set(SettingKey.GIT_CACHE, {
    ...settingsService.get(SettingKey.GIT_CACHE),
    localSourcePath: repoDir,
  });

  const result = await gitCacheService.ensureCommits({
    repository: 'demo/repo',
    commits: [shortSha],
    branches: ['main'],
  });

  assert.equal(result.available, true, result.reason);
  assert.equal(result.source, 'local');
  assert.equal(result.directory, repoDir);
  // 只读访问：用短哈希也能取到内容，且原仓库状态不变
  const file = await gitCacheService.readFile({
    repository: 'demo/repo',
    commit: shortSha,
    directory: result.directory,
    filePath: 'a.txt',
  });
  assert.match(file.content, /hello context/);
  assert.equal(git('status', '--porcelain'), '');
});

/** 本机仓库缺少该提交时必须如实说明，不能假装可用。 */
test('本机仓库没有目标提交时回退且说明原因', async () => {
  const result = await gitCacheService.ensureCommits({
    repository: 'demo/repo',
    commits: ['0123456789ab'],
    branches: [],
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /本地仓库缺少提交 0123456789ab/);
});

/** 上下文文件必须真正进入提示词，否则读取源码没有意义。 */
test('只读上下文文件会写入提示词，缺失时明确声明只有 diff', () => {
  const base = {
    pullRequest: { number: 1, title: 't', description: '', sourceCommit: 'a', targetCommit: 'b' },
    scope: { inScopeFiles: ['a.txt'], fallback: null },
    jiraSnapshot: { issues: [] },
    diffFiles: [],
  };

  const withContext = buildReviewPrompt({
    ...base,
    contextFiles: [{ filePath: 'a.txt', content: 'hello context', truncated: false }],
  });
  assert.match(withContext, /CONTEXT_FILE a\.txt/);
  assert.match(withContext, /hello context/);

  const without = buildReviewPrompt(base);
  assert.match(without, /只读上下文文件：无/);
  assert.doesNotMatch(without, /CONTEXT_FILE/);
});
