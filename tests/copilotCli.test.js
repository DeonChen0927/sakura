import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, parseEventLine, eventModel, describeEvent } from '../server/integrations/copilot/jsonl.js';
import { parseCliOutput } from '../server/integrations/copilot/live.js';

/** CLI 输出分块到达，行切分必须跨块重组，否则事件会被误判为非法 JSON。 */
test('行切分器跨数据块重组整行', () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push('{"type":"a"}\n{"ty');
  splitter.push('pe":"b"}\n');
  splitter.push('{"type":"c"}');
  splitter.flush();
  assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
});

test('非法行返回 null 而不是抛出', () => {
  assert.equal(parseEventLine('not json'), null);
  assert.equal(parseEventLine('"text"'), null);
  assert.deepEqual(parseEventLine('{"type":"result"}'), { type: 'result' });
});

test('事件模型与进度映射', () => {
  const event = { type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } };
  assert.equal(eventModel(event), 'claude-haiku-4.5');
  assert.equal(describeEvent(event).stage, 'session_created');
  assert.equal(describeEvent({ type: 'session.usage_checkpoint' }), null);
});

/** 真实格式：JSONL，最终回答在 assistant.message，会话号在 result。 */
test('解析真实 JSONL 输出', () => {
  const stdout = [
    JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } }),
    JSON.stringify({ type: 'assistant.message', data: { model: 'claude-haiku-4.5', content: '```json\n{"ok":true}\n```' } }),
    JSON.stringify({ type: 'result', sessionId: 'ddc2a69d', exitCode: 0 }),
  ].join('\n');

  const parsed = parseCliOutput(stdout);
  assert.equal(parsed.sessionId, 'ddc2a69d');
  assert.equal(parsed.modelUsed, 'claude-haiku-4.5');
  assert.deepEqual(parsed.result, { ok: true });
});

test('没有最终回答时必须失败，不能当作通过', () => {
  const stdout = JSON.stringify({ type: 'result', sessionId: 'x', exitCode: 0 });
  assert.throws(() => parseCliOutput(stdout), /没有返回最终回答/);
});

test('回答被截断时必须失败', () => {
  const stdout = JSON.stringify({ type: 'assistant.message', data: { content: '{"ok":tr' } });
  assert.throws(() => parseCliOutput(stdout), /没有结构化 JSON|解析失败/);
});
