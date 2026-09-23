import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-kb-'));

const { knowledgeBaseService, managedCheckoutPath, DEFAULT_WIKI_REMOTE } = await import(
  '../server/services/knowledgeBaseService.js'
);

const git = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

/** 造一个本地"远端"，用文件路径代替 Bitbucket，测克隆逻辑本身而不测网络。 */
function makeFakeWikiRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-wiki-src-'));
  fs.mkdirSync(path.join(dir, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'ei-wiki-answer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# wiki\n');
  fs.writeFileSync(path.join(dir, 'index.md'), '# index\n');
  fs.writeFileSync(path.join(dir, '_meta', 'lint.py'), 'print(1)\n');
  fs.writeFileSync(
    path.join(dir, '.claude', 'skills', 'ei-wiki-answer', 'SKILL.md'),
    '---\nname: ei-wiki-answer\ndescription: Answer questions from the wiki\n---\n',
  );
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], dir);
  return dir;
}

test.afterEach(() => {
  knowledgeBaseService.invalidate();
  knowledgeBaseService.resetProvisionCooldown();
  fs.rmSync(managedCheckoutPath(), { recursive: true, force: true });
});

test('默认远端指向 ei-llm-wiki，用户不需要自己先克隆', () => {
  assert.equal(DEFAULT_WIKI_REMOTE, 'git@bitbucket.org:agfahealthcare/ei-llm-wiki.git');
  assert.ok(managedCheckoutPath().endsWith(path.join('knowledge-base', 'ei-llm-wiki')));
});

test('本机没有 checkout 时自动克隆一次，之后解析到托管目录', async () => {
  const remote = makeFakeWikiRemote();
  const result = await knowledgeBaseService.provisionManagedCheckout(remote);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true, result.detail);

  knowledgeBaseService.invalidate();
  const status = await knowledgeBaseService.status();
  assert.equal(status.wiki.ok, true);
  assert.equal(status.wiki.source, 'managed');
  assert.equal(status.wiki.managed, true);
  assert.equal(status.wiki.path, managedCheckoutPath());
  // checkout 里的 canonical skill 能被读出来，说明克隆的是真的 wiki 结构
  assert.deepEqual(
    status.wiki.canonicalSkills.map((item) => item.name),
    ['ei-wiki-answer'],
  );
});

test('用户已配置的 checkout 优先于托管副本，不重复占磁盘', async () => {
  const existing = makeFakeWikiRemote();
  const remote = makeFakeWikiRemote();
  await knowledgeBaseService.provisionManagedCheckout(remote);
  knowledgeBaseService.invalidate();

  const original = knowledgeBaseService.settings;
  knowledgeBaseService.settings = () => ({ enabled: true, required: true, wikiRepoPath: existing });
  try {
    const status = await knowledgeBaseService.status();
    assert.equal(status.wiki.path, path.resolve(existing));
    assert.equal(status.wiki.source, 'setting');
    assert.notEqual(status.wiki.path, managedCheckoutPath());
  } finally {
    knowledgeBaseService.settings = original;
  }
});

test('克隆失败不留半成品，并进入冷却避免每次前置检查重撞同一个错误', async () => {
  const missing = path.join(os.tmpdir(), `sakura-no-such-remote-${Date.now()}`);
  const first = await knowledgeBaseService.provisionManagedCheckout(missing);
  assert.equal(first.attempted, true);
  assert.equal(first.ok, false);
  assert.ok(first.detail.length > 0);
  assert.equal(fs.existsSync(managedCheckoutPath()), false, '失败后不应留下半成品 checkout');

  const second = await knowledgeBaseService.provisionManagedCheckout(missing);
  assert.equal(second.attempted, false, '冷却期内不应重复尝试');

  knowledgeBaseService.resetProvisionCooldown();
  const third = await knowledgeBaseService.provisionManagedCheckout(missing);
  assert.equal(third.attempted, true, '显式刷新后应立即重试');
});

test('目标目录已有内容时拒绝克隆，不覆盖任何已存在的数据', async () => {
  const target = managedCheckoutPath();
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep-me.txt'), 'important');

  const result = await knowledgeBaseService.provisionManagedCheckout(makeFakeWikiRemote());
  assert.equal(result.ok, false);
  assert.match(result.detail, /不是有效的 ei-llm-wiki checkout/);
  assert.equal(fs.readFileSync(path.join(target, 'keep-me.txt'), 'utf8'), 'important');
});

test('演示模式不触发克隆：没有真实调用 CLI 就不该动用户磁盘', async () => {
  const original = knowledgeBaseService.provisionManagedCheckout;
  let called = false;
  knowledgeBaseService.provisionManagedCheckout = async () => {
    called = true;
    return { attempted: true, ok: true };
  };
  try {
    const status = await knowledgeBaseService.ensure();
    assert.equal(status.demo, true);
    assert.equal(called, false);
  } finally {
    knowledgeBaseService.provisionManagedCheckout = original;
  }
});

test('知识库关闭时不克隆，也不谎称可用', async () => {
  const original = knowledgeBaseService.settings;
  knowledgeBaseService.settings = () => ({ enabled: false });
  try {
    const status = await knowledgeBaseService.ensure();
    assert.equal(status.enabled, false);
    assert.equal(status.available, false);
    assert.equal(fs.existsSync(managedCheckoutPath()), false);
  } finally {
    knowledgeBaseService.settings = original;
  }
});
