import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-tracking-'));
process.env.SAKURA_INTEGRATION_MODE = 'mock';

const { createServer } = await import('../server/index.js');
const { closeDb } = await import('../server/db/database.js');

function createClient(baseUrl) {
  const cookies = new Map();
  const jar = () => [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');

  async function request(method, pathname, body) {
    const headers = { cookie: jar() };
    if (cookies.has('sakura_csrf')) headers['x-sakura-csrf'] = cookies.get('sakura_csrf');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1)));
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  return {
    get: (pathname) => request('GET', pathname),
    post: (pathname, body) => request('POST', pathname, body ?? {}),
    patch: (pathname, body) => request('PATCH', pathname, body),
    put: (pathname, body) => request('PUT', pathname, body),
  };
}

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const client = createClient(`http://127.0.0.1:${server.address().port}`);

test.after(() => {
  server.close();
  closeDb();
  fs.rmSync(process.env.SAKURA_DATA_DIR, { recursive: true, force: true });
});

const PR_ID = encodeURIComponent('example-org/example-repo#2481');
const NO_JIRA_PR_ID = encodeURIComponent('example-org/example-repo#2476');

const waitForRound = async (roundId) => {
  for (let i = 0; i < 100; i += 1) {
    const { body } = await client.get(`/api/rounds/${roundId}`);
    if (!['preflight', 'running'].includes(body.round.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('评审轮次超时未结束');
};

test('演示模式明确说明 Git 缓存不可用，不伪装已拉取真实仓库', async () => {
  await client.get('/api/bootstrap');
  await client.post('/api/prs/sync');
  const { body } = await client.get(`/api/prs/${PR_ID}/preflight`);
  assert.equal(body.gitCache.available, false);
  assert.match(body.gitCache.reason, /演示模式/);
  assert.ok(body.warnings.some((item) => item.code === 'git_cache_unavailable'));
  assert.equal(body.canStart, true, 'Git 缓存不可用只是警告，不应阻断评审');

  const status = await client.get('/api/git-cache');
  assert.equal(status.body.isolatedFromWorkspace, true);
  assert.ok(status.body.directory.includes('repo-cache'));
  assert.ok(!/@/.test(status.body.remoteUrl), '远端地址不得内嵌凭据');
});

test('清理 Git 缓存先给出影响预览，不擅自删除', async () => {
  const preview = await client.post('/api/git-cache/clear', {});
  assert.equal(preview.body.removed, false);
  assert.ok(preview.body.preview);
});

test('人工补充的 Jira key 会持久化并参与核对', async () => {
  const before = await client.get(`/api/prs/${NO_JIRA_PR_ID}/preflight`);
  assert.equal(before.body.jiraSnapshot.issues.length, 0);

  const bad = await client.put(`/api/prs/${NO_JIRA_PR_ID}/jira-keys`, { keys: ['not-a-key'] });
  assert.equal(bad.status, 400);

  const after = await client.put(`/api/prs/${NO_JIRA_PR_ID}/jira-keys`, { keys: ['seal-1042'] });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.manualJiraKeys, ['SEAL-1042']);
  assert.equal(after.body.jiraSnapshot.issues[0].key, 'SEAL-1042');
  assert.ok(
    after.body.jiraSnapshot.issues[0].sources.some((item) => item.source === 'manual'),
    '必须显示关联来源，便于核对',
  );

  const reread = await client.get(`/api/prs/${NO_JIRA_PR_ID}/preflight`);
  assert.deepEqual(reread.body.manualJiraKeys, ['SEAL-1042'], '刷新后仍保留人工补充的关联');

  await client.put(`/api/prs/${NO_JIRA_PR_ID}/jira-keys`, { keys: [] });
});

test('新一轮比对上一轮发现，未提及只记为无法确认', async () => {
  const first = await client.post(`/api/prs/${PR_ID}/review`);
  const firstDone = await waitForRound(first.body.round.id);
  assert.equal(firstDone.round.status, 'awaiting_confirmation');
  assert.equal(firstDone.carryover.length, 0, '第一轮没有上一轮可比对');

  const second = await client.post(`/api/prs/${PR_ID}/review`);
  const secondDone = await waitForRound(second.body.round.id);
  assert.ok(secondDone.carryover.length > 0);
  assert.ok(
    secondDone.carryover.every((item) =>
      ['still_present', 'unverifiable'].includes(item.verdict),
    ),
    '系统不得自动认定为已修复',
  );
  assert.ok(secondDone.carryover.every((item) => item.decidedBy === 'system'));
  assert.ok(secondDone.carryover.every((item) => item.finding?.titleZh));

  const target = secondDone.carryover[0];
  const invalid = await client.patch(`/api/carryover/${target.id}`, { verdict: 'done' });
  assert.equal(invalid.status, 400);

  const updated = await client.patch(`/api/carryover/${target.id}`, {
    verdict: 'fixed',
    note: '已在本轮确认修复',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.verdict, 'fixed');
  assert.equal(updated.body.decidedBy, 'user');

  const reread = await client.get(`/api/rounds/${second.body.round.id}`);
  assert.equal(
    reread.body.carryover.find((item) => item.id === target.id).verdict,
    'fixed',
    '人工判断必须持久化',
  );
});
