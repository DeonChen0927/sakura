import { h, clear, pill, notice, shortCommit, toast } from './dom.js';
import { api } from './api.js';
import { actions } from './state.js';

const ACTIONS = [
  ['request_changes', 'Request changes', '要求作者修改，更新你的远端评审状态'],
  ['approve', 'Approve', '批准该 PR，更新你的远端评审状态'],
  ['comment_only', '仅评论', '只发布评论，保留你现有的远端评审状态'],
];

const CONFIRM_LABEL = {
  approve: '确认批准',
  request_changes: '确认请求修改',
  comment_only: '确认仅发布评论',
};

let currentRoundId = null;
let currentAction = null;
let currentPreview = null;
let busy = false;

const dialog = () => document.getElementById('publish-dialog');

async function refresh() {
  currentPreview = await api.publishPreview(currentRoundId, currentAction ?? 'comment_only');
  if (!currentAction) {
    currentPreview.canPublish = false;
    currentPreview.errors = ['请先手动选择评审动作；系统不会替你预选。'];
  }
  render();
}

function renderItems(preview) {
  if (!preview.items.length) {
    return notice('warning', '没有可发布的内容。仅有署名、没有实质正文时不能发布。');
  }
  return preview.items.map((item) =>
    h(
      'div',
      { class: 'preview-comment' },
      h(
        'small',
        {},
        item.kind === 'summary'
          ? '总结（PR 级评论）'
          : `${item.filePath}:${item.line} · ${item.findingKey}`,
      ),
      h('p', {}, item.body),
    ),
  );
}

function render() {
  const node = dialog();
  const preview = currentPreview;
  clear(node);

  const form = h(
    'form',
    { method: 'dialog' },
    h(
      'div',
      { class: 'dialog-heading' },
      h(
        'div',
        {},
        h('h2', {}, '发布预览'),
        h(
          'p',
          { class: 'muted' },
          preview.demo
            ? '演示模式：确认后只写入本地演示数据，无真实发布。'
            : `确认后将以 ${preview.publisher.name} 的身份写入 Bitbucket。`,
        ),
      ),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          'aria-label': '关闭',
          onclick: () => node.close(),
        },
        '×',
      ),
    ),
    h(
      'p',
      { class: 'dialog-context' },
      `PR #${preview.pullRequest.number} · 第 ${preview.round.roundNumber} 轮 · 本轮模型 ${preview.round.model.name} · 源 ${shortCommit(preview.round.sourceCommit)} → 目标 ${shortCommit(preview.round.targetCommit)}`,
    ),
    h(
      'div',
      { class: 'dialog-scroll' },
      preview.demo ? notice('neutral', '演示：以下署名为示例展示，不代表已由指定模型真实生成或已真实发布。') : null,
      h(
        'div',
        { class: 'section-heading' },
        h('h3', {}, '将按顺序发布的英文内容'),
        pill(`${preview.items.length} 条`, 'gray'),
      ),
      renderItems(preview),
      h(
        'fieldset',
        { class: 'action-choices' },
        h('legend', {}, '评审动作', h('span', {}, 'AI 建议仅供参考，必须由你选择')),
        ACTIONS.map(([value, label, description]) =>
          h(
            'label',
            {},
            h('input', {
              type: 'radio',
              name: 'publish-action',
              value,
              checked: currentAction === value,
              onchange: async () => {
                currentAction = value;
                await refresh();
              },
            }),
            h('div', {}, h('strong', {}, label), h('small', {}, description)),
          ),
        ),
      ),
      preview.suggestedAction
        ? h(
            'p',
            { class: 'help' },
            `AI 建议：${ACTIONS.find(([value]) => value === preview.suggestedAction)?.[1] ?? preview.suggestedAction}`,
          )
        : null,
      currentAction === 'approve' && preview.suggestedAction === 'request_changes'
        ? notice('warning', h('strong', {}, '冲突提示：'), 'AI 建议请求修改，你选择了 Approve，必须填写英文覆盖理由并二次确认。')
        : null,
      h(
        'p',
        { class: 'validation', role: 'alert' },
        preview.errors.length ? preview.errors.join('；') : '',
      ),
      h(
        'p',
        { class: 'help' },
        '确认后将重新校验 PR 版本与关联需求；若已变化，本次发布会被取消并标记过期。',
      ),
    ),
    h(
      'div',
      { class: 'dialog-footer' },
      h('button', { class: 'button', type: 'button', onclick: () => node.close() }, '返回编辑'),
      h(
        'button',
        {
          class: 'button primary',
          type: 'button',
          disabled: !preview.canPublish || busy,
          onclick: () => confirmPublish(),
        },
        `${preview.demo ? '模拟' : ''}${CONFIRM_LABEL[currentAction] ?? '确认发布'}`,
      ),
    ),
  );

  node.append(form);
}

async function confirmPublish() {
  if (busy) return;
  busy = true;
  render();
  try {
    const result = await api.publish(currentRoundId, currentAction);
    const status = result.batch.status;
    if (status === 'succeeded') toast('发布成功，已记录逐项回执');
    else if (status === 'partial') toast('部分成功：评审状态未更新，可稍后重试未成功的步骤');
    else toast('发布失败，请查看回执详情');
    dialog().close();
    await actions.loadRound(currentRoundId);
    await actions.refreshRounds();
  } catch (error) {
    toast(`发布被阻止：${error.message}`);
    await actions.loadRound(currentRoundId);
  } finally {
    busy = false;
  }
}

export async function openPublishDialog(roundId) {
  currentRoundId = roundId;
  currentAction = null;
  busy = false;
  try {
    await refresh();
    dialog().showModal();
  } catch (error) {
    toast(`无法打开发布预览：${error.message}`);
  }
}
