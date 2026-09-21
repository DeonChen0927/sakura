import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SAKURA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-test-'));
process.env.SAKURA_INTEGRATION_MODE = 'mock';

const { createServer } = await import('../server/index.js');
const { closeDb } = await import('../server/db/database.js');

function createClient(baseUrl) {
  const cookies = new Map();
  const jar = () =>
    [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');

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
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
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
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const client = createClient(baseUrl);

test.after(() => {
  server.close();
  closeDb();
  fs.rmSync(process.env.SAKURA_DATA_DIR, { recursive: true, force: true });
});

const waitForRound = async (roundId) => {
  for (let i = 0; i < 100; i += 1) {
    const { body } = await client.get(`/api/rounds/${roundId}`);
    if (!['preflight', 'running'].includes(body.round.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('评审轮次超时未结束');
};

test('本地会话与 CSRF 保护', async () => {
  const bootstrap = await client.get('/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.connection.demo, true);

  const noCsrf = await fetch(`${baseUrl}/api/prs/sync`, { method: 'POST' });
  assert.equal(noCsrf.status, 401);
});

test('同步 PR 列表并识别本地状态', async () => {
  const { status, body } = await client.post('/api/prs/sync');
  assert.equal(status, 200);
  assert.ok(body.items.length >= 3);
  assert.ok(body.items.every((pr) => pr.localState === 'pending'));
});

test('缺少 Team Seal 标记时回退为评审全部变更，不阻断', async () => {
  const prId = encodeURIComponent('example-org/example-repo#2476');
  const { body } = await client.get(`/api/prs/${prId}/preflight`);
  assert.equal(body.scope.fallback, 'all_changes');
  assert.ok(body.warnings.some((item) => item.code === 'scope_marker_missing'));
  assert.ok(!body.blockers.some((item) => item.code.startsWith('scope_')));
});

test('Jira 缺少验收标准时只提醒，不阻止启动', async () => {
  const prId = encodeURIComponent('example-org/example-repo#2469');
  const { body } = await client.get(`/api/prs/${prId}/preflight`);
  assert.equal(body.canStart, true, JSON.stringify(body.blockers));
  assert.ok(body.warnings.some((item) => item.code === 'jira_acceptance_missing'));
});

test('完整评审到发布流程', async (t) => {
  const prId = encodeURIComponent('example-org/example-repo#2481');

  const preflight = await client.get(`/api/prs/${prId}/preflight`);
  assert.equal(preflight.body.canStart, true, JSON.stringify(preflight.body.blockers));
  assert.equal(preflight.body.model.id, 'claude-opus-5');
  assert.ok(preflight.body.scope.inScopeFiles.length >= 3);
  assert.ok(preflight.body.scope.outOfScopeFiles.includes('docs/release-notes/2026-09.md'));

  const started = await client.post(`/api/prs/${prId}/review`);
  assert.equal(started.status, 202);
  const roundId = started.body.round.id;

  const detail = await waitForRound(roundId);
  assert.equal(detail.round.status, 'awaiting_confirmation');
  assert.ok(detail.findings.length > 0);
  assert.ok(detail.attribution.text.includes('Claude Opus 5'));
  assert.ok(detail.draftSignature.includes('Pending human confirmation'));
  assert.equal(detail.freshness.fresh, true);

  await t.test('正式发现必须落在范围内', () => {
    for (const finding of detail.findings) {
      assert.ok(detail.round.scope.inScopeFiles.includes(finding.filePath));
    }
  });

  await t.test('人工修订不覆盖 AI 原文', async () => {
    const finding = detail.findings[0];
    const edited = 'Please switch to a concurrent map before this lands.';
    const { body } = await client.patch(`/api/findings/${finding.id}`, { commentEn: edited });
    assert.equal(body.revision.commentEn, edited);
    assert.equal(body.aiCommentEn, finding.aiCommentEn);
  });

  await t.test('排除的发现不进入发布内容', async () => {
    if (detail.findings.length < 2) return;
    await client.patch(`/api/findings/${detail.findings[1].id}`, { selected: false });
    const preview = await client.post(`/api/rounds/${roundId}/publish/preview`, {
      action: 'request_changes',
    });
    assert.ok(!preview.body.items.some((item) => item.findingKey === detail.findings[1].key));
  });

  await t.test('署名不重复、不丢失', async () => {
    const preview = await client.post(`/api/rounds/${roundId}/publish/preview`, {
      action: 'request_changes',
    });
    for (const item of preview.body.items) {
      const count = item.body.split('AI-assisted review by Sakura').length - 1;
      assert.equal(count, 1);
      assert.ok(item.body.includes('Human-reviewed and published by Sakura Demo User.'));
    }
    const again = await client.post(`/api/rounds/${roundId}/publish/preview`, {
      action: 'request_changes',
    });
    assert.deepEqual(
      again.body.items.map((item) => item.body),
      preview.body.items.map((item) => item.body),
    );
  });

  await t.test('AI 建议请求修改时 Approve 需要覆盖理由', async () => {
    const preview = await client.post(`/api/rounds/${roundId}/publish/preview`, {
      action: 'approve',
    });
    assert.equal(preview.body.canPublish, false);
    assert.ok(preview.body.errors.some((item) => item.includes('覆盖理由')));
  });

  await t.test('发布成功后写入回执并更新评审状态', async () => {
    const preview = await client.post(`/api/rounds/${roundId}/publish/preview`, {
      action: 'request_changes',
    });
    assert.equal(preview.body.canPublish, true, JSON.stringify(preview.body.errors));

    const published = await client.post(`/api/rounds/${roundId}/publish`, {
      action: 'request_changes',
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.batch.status, 'succeeded');
    assert.ok(published.body.items.every((item) => item.status === 'succeeded'));
    assert.ok(published.body.items.every((item) => item.remoteCommentId));

    const list = await client.get('/api/prs');
    const pr = list.body.items.find((item) => item.number === 2481);
    assert.equal(pr.myReviewState, 'changes_requested');
  });

  await t.test('重复发布同一批次不会重复写入远端', async () => {
    const first = await client.post(`/api/rounds/${roundId}/publish`, { action: 'request_changes' });
    const ids = first.body.items.map((item) => item.remoteCommentId);
    const second = await client.post(`/api/rounds/${roundId}/publish`, { action: 'request_changes' });
    assert.deepEqual(second.body.items.map((item) => item.remoteCommentId), ids);
  });

  await t.test('多轮评审保留历史', async () => {
    const second = await client.post(`/api/prs/${prId}/review`);
    assert.equal(second.status, 202);
    await waitForRound(second.body.round.id);
    const rounds = await client.get(`/api/prs/${prId}/rounds`);
    assert.equal(rounds.body.length, 2);
    assert.equal(rounds.body[0].roundNumber, 2);
  });
});

test('修改全局模型不影响已有轮次署名', async () => {
  const before = await client.get('/api/history');
  const round = before.body.rounds[0];
  assert.equal(round.model.id, 'claude-opus-5');

  await client.put('/api/settings/model', { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' });
  const detail = await client.get(`/api/rounds/${round.id}`);
  assert.equal(detail.body.round.model.id, 'claude-opus-5');
  assert.ok(detail.body.attribution.text.includes('Claude Opus 5'));

  const status = await client.get('/api/connection/status');
  assert.equal(status.body.reviewModel.id, 'claude-sonnet-5');
  await client.put('/api/settings/model', { id: 'claude-opus-5', name: 'Claude Opus 5' });
});
