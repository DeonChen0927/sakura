import { h } from '../dom.js';

const MARK = { added: '+', removed: '-', context: ' ' };

/** 代码差异渲染：长代码横向滚动不折行，行号保留新旧两侧（UI/UX 3、5.2）。 */
export function renderDiff({ files, activeFile, focusLine, onSelectFile }) {
  const file = files.find((item) => item.path === activeFile) ?? files[0];

  const tabs = h(
    'div',
    { class: 'file-tabs' },
    files.map((item) =>
      h(
        'button',
        {
          class: `file-tab${item === file ? ' active' : ''}`,
          type: 'button',
          onclick: () => onSelectFile(item.path),
          title: item.path,
        },
        item.path.split('/').pop(),
      ),
    ),
  );

  const table = h('table', { class: 'diff-table' });
  const body = h('tbody');
  if (file) {
    for (const hunk of file.hunks ?? []) {
      body.append(
        h(
          'tr',
          { class: 'hunk' },
          h('th', {}, '…'),
          h('th', {}, '…'),
          h('td', { class: 'mark' }, ''),
          h('td', {}, hunk.header),
        ),
      );
      for (const line of hunk.lines ?? []) {
        const focused =
          focusLine &&
          focusLine.filePath === file.path &&
          ((focusLine.newLine && line.newLine === focusLine.newLine) ||
            (focusLine.oldLine && line.oldLine === focusLine.oldLine));
        body.append(
          h(
            'tr',
            { class: `${line.type}${focused ? ' focus-line' : ''}` },
            h('th', {}, line.oldLine ?? ''),
            h('th', {}, line.newLine ?? ''),
            h('td', { class: 'mark' }, MARK[line.type] ?? ' '),
            h('td', {}, line.content),
          ),
        );
      }
    }
  }
  table.append(body);

  return h(
    'div',
    { class: 'code-panel' },
    h(
      'div',
      { class: 'panel-title' },
      h('span', {}, '代码差异'),
      h('span', { class: 'diff-stats' }, `${files.length} 个文件`),
    ),
    tabs,
    h('p', { class: 'file-path' }, file ? file.path : '没有可显示的文件'),
    h('div', { class: 'diff-scroll' }, table),
    h(
      'p',
      { class: 'code-note' },
      h('strong', {}, '范围提示'),
      '只有 Team Seal 范围内的变更可以产生正式发现；范围外文件仅作为只读上下文。',
    ),
  );
}

export function focusDiffLine(container) {
  container.querySelector('.focus-line')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
