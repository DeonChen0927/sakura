import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBitbucketClient } from '../server/integrations/bitbucket/live.js';

const USER = { uuid: '{deon}', account_id: 'acc-1', display_name: 'Deon Chen', nickname: 'deon' };

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    const body = handler(new URL(url), calls.length);
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const prPayload = (id) => ({
  id,
  title: `PR ${id}`,
  state: 'OPEN',
  draft: false,
  updated_on: '2026-01-01T00:00:00Z',
  author: { uuid: '{someone}', display_name: 'Someone' },
  source: { branch: { name: 'feat' }, commit: { hash: 'aaa' } },
  destination: { branch: { name: 'main' }, commit: { hash: 'bbb' } },
  links: { html: { href: `https://bitbucket.org/pr/${id}` } },
  participants: [{ user: { uuid: '{deon}' }, role: 'REVIEWER', state: null }],
});

const client = () =>
  createLiveBitbucketClient({ getToken: async () => 'token', authScheme: 'bearer' });

test('待我评审列表在服务端过滤，不拉取全仓库 OPEN PR', async () => {
  const stub = stubFetch((url) => (url.pathname === '/2.0/user'
    ? USER
    : { values: [prPayload(1)], next: null }));
  try {
    const list = await client().listPullRequestsForReview({ repository: 'ws/repo' });
    assert.equal(list.length, 1);

    const query = stub.calls[1].searchParams;
    assert.equal(query.get('q'), 'state="OPEN" AND reviewers.uuid="{deon}"');
    // 字段白名单：必须显式带上 id 与 next，否则会丢数据或无法翻页。
    const fields = query.get('fields').split(',');
    assert.ok(fields.includes('next'));
    assert.ok(fields.includes('values.id'));
    assert.ok(!fields.some((field) => field.startsWith('+')));
  } finally {
    stub.restore();
  }
});

test('一次刷新只产生 1 次身份查询 + 1 次列表查询', async () => {
  const stub = stubFetch((url) => (url.pathname === '/2.0/user'
    ? USER
    : { values: [prPayload(1), prPayload(2)], next: null }));
  try {
    const bitbucket = client();
    await bitbucket.listPullRequestsForReview({ repository: 'ws/repo' });
    assert.equal(stub.calls.length, 2);

    // 身份在客户端生命周期内复用：后续刷新不再重复问 /user。
    await bitbucket.listPullRequestsForReview({ repository: 'ws/repo' });
    assert.equal(stub.calls.length, 3);
    assert.equal(stub.calls.filter((url) => url.pathname === '/2.0/user').length, 1);
  } finally {
    stub.restore();
  }
});

test('连接测试强制重新查询身份，不拿缓存冒充成功', async () => {
  const stub = stubFetch(() => USER);
  try {
    const bitbucket = client();
    await bitbucket.getCurrentUser();
    await bitbucket.testConnection();
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});
