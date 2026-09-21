import { h, pill, formatTime, shortCommit } from '../dom.js';
import { state, actions, ensureLoaded } from '../state.js';

const STATUS_LABEL = {
  pending: ['待开始', 'gray'],
  preflight: ['前置检查', 'amber'],
  running: ['运行中', 'amber'],
  awaiting_confirmation: ['待确认', 'pink'],
  closed_remote: ['已完结（远端已表态）', 'green'],
  cancelled: ['已取消', 'gray'],
  failed: ['失败', 'red'],
  expired: ['已过期', 'amber'],
};

const BATCH_LABEL = {
  pending: ['未发布', 'gray'],
  running: ['发布中', 'amber'],
  partial: ['部分成功', 'amber'],
  succeeded: ['已成功', 'green'],
  failed: ['失败', 'red'],
  aborted: ['已取消', 'gray'],
};

/** 评审历史：每轮的输入版本、模型、发布回执均可回看（FR-08 / AC12 / AC19）。 */
export function renderHistoryPage() {
  ensureLoaded('history', () => actions.loadHistory());

  const rows = state.history.map((round) => {
    const [statusLabel, statusTone] = STATUS_LABEL[round.status] ?? ['未知', 'gray'];
    const [batchLabel, batchTone] = round.publish
      ? BATCH_LABEL[round.publish.status] ?? ['未知', 'gray']
      : ['未发布', 'gray'];
    return h(
      'tr',
      {},
      h('td', {}, `#${round.pullRequest.number}`),
      h('td', {}, round.pullRequest.title),
      h('td', {}, `第 ${round.roundNumber} 轮`),
      h('td', {}, pill(statusLabel, statusTone)),
      h('td', {}, round.model.name),
      h('td', {}, h('code', {}, shortCommit(round.sourceCommit))),
      h('td', {}, pill(batchLabel, batchTone)),
      h('td', {}, formatTime(round.startedAt)),
    );
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-heading' },
      h(
        'div',
        {},
        h('span', { class: 'eyebrow' }, 'HISTORY'),
        h('h1', {}, '评审历史'),
        h('p', {}, '旧轮次保持只读可查；报告署名固定为该轮实际模型。'),
      ),
      h(
        'button',
        { class: 'button', type: 'button', onclick: () => actions.loadHistory() },
        '刷新',
      ),
    ),
    h(
      'div',
      { class: 'content-card table-scroll' },
      rows.length
        ? h(
            'table',
            { class: 'history-table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['PR', '标题', '轮次', '本地状态', '本轮模型', '源版本', '发布批次', '开始时间'].map(
                  (label) => h('th', {}, label),
                ),
              ),
            ),
            h('tbody', {}, rows),
          )
        : h('p', { class: 'muted' }, '还没有评审记录。'),
    ),
  );
}
