import { h, pill, notice, formatTime, shortCommit, autosave, toast } from '../dom.js';
import { api } from '../api.js';
import { state, update, actions } from '../state.js';
import { renderDiff } from './diff.js';
import { openPublishDialog } from '../publishDialog.js';

const LOCAL_STATE_LABEL = {
  pending: ['待开始', 'gray'],
  preflight: ['前置检查', 'amber'],
  running: ['运行中', 'amber'],
  awaiting_confirmation: ['待你确认', 'pink'],
  closed_remote: ['已完结（远端已表态）', 'green'],
  cancelled: ['已取消', 'gray'],
  failed: ['失败', 'red'],
  expired: ['已过期', 'amber'],
  published: ['已发布', 'green'],
};

const REMOTE_STATE_LABEL = {
  none: '未表态',
  approved: 'Approved',
  changes_requested: 'Changes requested',
};

const REMOTE_STATE_TONE = {
  approved: 'green',
  changes_requested: 'red',
  none: 'gray',
};

/** 远端已表态即视为「这轮不用我再评审」；本地轮次状态是另一条线，不互相覆盖。 */
const hasRemoteState = (pr) => pr.myReviewState && pr.myReviewState !== 'none';

/** 远端已不再把它列为待我评审（合并、关闭、被移出评审人）：保留记录但不算待办。 */
const isRemoteMissing = (pr) => Boolean(pr.remoteMissing);

/** 本地轮次仍需要你做点什么（在跑、待确认、失败、过期）才值得在卡片上单独提一句。 */
const localNeedsAttention = (pr) =>
  ['preflight', 'running', 'awaiting_confirmation', 'failed', 'expired'].includes(pr.localState);

const needsMyReview = (pr) => !hasRemoteState(pr) && !isRemoteMissing(pr);

const SEVERITY_LABEL = {
  blocking: ['阻断', 'red'],
  important: ['重要', 'amber'],
  suggestion: ['建议', 'gray'],
};

const VERDICT_LABEL = {
  met: ['符合', 'green'],
  not_met: ['不符合', 'red'],
  unverifiable: ['静态代码无法验证', 'amber'],
};

const saveFinding = autosave((id, patch) => api.updateFinding(id, patch));
const saveSummary = autosave((id, patch) => api.updateSummary(id, patch));

function matchesFilter(pr) {
  const keyword = state.search.trim().toLowerCase();
  if (keyword) {
    const haystack = [pr.number, pr.title, ...(pr.jiraKeys ?? [])].join(' ').toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  if (state.filter === 'all') return true;
  if (state.filter === 'todo') {
    // 已表态、或远端已不再列为待我评审的，都不算待处理。
    return needsMyReview(pr) && ['pending', 'expired', 'failed'].includes(pr.localState);
  }
  if (state.filter === 'unstated') return needsMyReview(pr);
  if (state.filter === 'stated') return hasRemoteState(pr) || isRemoteMissing(pr);
  if (state.filter === 'awaiting') return pr.localState === 'awaiting_confirmation';
  return pr.localState === state.filter;
}

function renderSummaryRow(items) {
  const count = (predicate) => items.filter(predicate).length;
  const cards = [
    ['待我评审', count(needsMyReview), '✿'],
    ['已在远端表态', count(hasRemoteState), '✓'],
    ['待你确认', count((pr) => pr.localState === 'awaiting_confirmation'), '☑'],
    ['需处理', count((pr) => needsMyReview(pr) && ['failed', 'expired'].includes(pr.localState)), '⚠'],
  ];
  return h(
    'div',
    { class: 'summary-row' },
    cards.map(([label, value, symbol]) =>
      h(
        'div',
        { class: 'summary-card' },
        h('span', { class: 'summary-symbol', 'aria-hidden': 'true' }, symbol),
        h('div', {}, h('strong', {}, String(value)), h('small', {}, label)),
      ),
    ),
  );
}

function renderPrList(items) {
  const filtered = items.filter(matchesFilter);

  const cards = filtered.length
    ? filtered.map((pr) => {
        const [label, tone] = LOCAL_STATE_LABEL[pr.localState] ?? ['未知', 'gray'];
        // 远端已表态的 PR 一律以远端状态为主状态：这类 PR 不需要我再评一次，
        // 本地轮次只有在还需要你处理时才在小字里补一句。
        const showRemoteAsPrimary = hasRemoteState(pr);
        const missing = isRemoteMissing(pr);
        return h(
          'button',
          {
            class: `pr-card${pr.id === state.selectedPrId ? ' selected' : ''}`,
            type: 'button',
            'aria-current': pr.id === state.selectedPrId ? 'true' : null,
            onclick: () => actions.selectPr(pr.id),
          },
            h(
              'div',
              { class: 'pr-card-top' },
              h('span', {}, `#${pr.number}`),
              pr.isDraft ? pill('Draft', 'amber') : null,
              missing ? pill('已不在待评审列表', 'gray') : null,
            ),
          h('h3', {}, pr.title),
          h(
            'div',
            { class: 'pr-card-bottom' },
            h('span', {}, pr.author?.name ?? '未知作者'),
            showRemoteAsPrimary
              ? pill(REMOTE_STATE_LABEL[pr.myReviewState], REMOTE_STATE_TONE[pr.myReviewState] ?? 'gray')
              : pill(label, tone),
          ),
          h(
            'small',
            { class: 'remote-state' },
            showRemoteAsPrimary
              ? `你已在 Bitbucket 表态${localNeedsAttention(pr) ? ` · 本地评审：${label}` : ''}`
              : missing
                ? `Bitbucket 已不再列为待你评审（${pr.lifecycleState ?? '状态未知'}）· 本地评审：${label}`
                : `远端评审：${REMOTE_STATE_LABEL[pr.myReviewState] ?? pr.myReviewState}`,
            (pr.jiraKeys ?? []).length ? ` · ${pr.jiraKeys.join(' / ')}` : ' · 无 Jira 关联',
          ),
        );
      })
    : [
        h(
          'div',
          { class: 'empty' },
          h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '✽'),
          h('h3', {}, items.length ? '没有符合条件的 PR' : '列表为空'),
          h(
            'p',
            {},
            items.length ? '请调整搜索关键词或状态筛选。' : '点击「刷新」从 Bitbucket 同步待你评审的 PR。',
          ),
        ),
      ];

  return h(
    'section',
    { class: 'pr-list', 'aria-label': 'PR 列表' },
    h(
      'div',
      { class: 'list-heading' },
      h('strong', {}, '待我评审'),
      h('span', { class: 'muted' }, `${filtered.length}/${items.length}`),
    ),
    h(
      'div',
      { class: 'list-tools' },
      h('input', {
        class: 'search',
        type: 'search',
        value: state.search,
        placeholder: '搜索 PR 编号 / 标题 / Jira',
        'aria-label': '搜索 PR',
        oninput: (event) => update({ search: event.target.value }),
      }),
      h(
        'select',
        {
          'aria-label': '按状态筛选',
          onchange: (event) => update({ filter: event.target.value }),
        },
        [
          ['all', '全部'],
          ['todo', '需处理'],
          ['unstated', '远端未表态'],
          ['stated', '远端已表态'],
          ['awaiting', '待你确认'],
          ['published', '已发布'],
        ].map(([value, label]) =>
          h('option', { value, selected: state.filter === value }, label),
        ),
      ),
    ),
    ...cards,
    h(
      'p',
      { class: 'list-footnote' },
      `最近同步：${formatTime(state.prs.syncedAt)}`,
      h('br'),
      '刷新只同步远端数据，不会自动发起 AI 评审。',
    ),
  );
}

function originLabel(origin) {
  if (!origin || origin === 'description') return 'PR 描述';
  if (origin.startsWith('comment:')) return `PR 评论 #${origin.slice('comment:'.length)} `;
  return origin;
}

const SCOPE_POLICY_PILL = {
  author_is_me: ['你发起的 PR：评审全部', 'pink'],
  author_in_team: ['团队成员发起：评审全部', 'pink'],
};

function renderScopeStrip(preflight) {
  const scope = preflight.scope;
  const items = [];
  const policy = SCOPE_POLICY_PILL[scope.policy];
  items.push(
    policy
      ? pill(`${policy[0]} ${scope.inScopeFiles.length} 个变更文件`, policy[1])
      : scope.fallback
        ? pill(`未识别 Team Seal 范围：评审全部 ${scope.inScopeFiles.length} 个变更文件`, 'amber')
        : pill(`Team Seal 范围：${scope.inScopeFiles.length} 个文件`, 'green'),
  );
  const jiraOk = preflight.jiraCheck.ok;
  const noCriteria = (preflight.warnings ?? []).some((item) => item.code === 'jira_acceptance_missing');
  items.push(
    jiraOk
      ? pill(
          `Jira：${preflight.jiraSnapshot.issues.map((issue) => issue.key).join(' / ')}${
            noCriteria ? '（无验收标准）' : ''
          }`,
          noCriteria ? 'amber' : 'green',
        )
      : pill('Jira 需求信息不完整', 'red'),
  );
  items.push(pill(`本轮候选模型：${preflight.model.name ?? '未配置'}`, 'pink'));
  const cache = preflight.gitCache ?? {};
  const CONTEXT_SOURCE = {
    local: ['上下文：本机仓库（只读）', 'green'],
    cache: ['上下文：本地缓存', 'green'],
    remote: ['上下文：已拉取到缓存', 'green'],
  };
  const [contextLabel, contextTone] = cache.available
    ? CONTEXT_SOURCE[cache.source] ?? ['上下文：已就绪', 'green']
    : ['上下文：仅 PR diff', 'amber'];
  items.push(pill(contextLabel, contextTone));
  const kb = preflight.knowledgeBase ?? {};
  items.push(
    kb.enabled === false
      ? pill('知识库：已关闭', 'amber')
      : kb.demo
        ? pill('知识库：演示模式不调用', 'demo')
        : kb.available
          ? pill(
              `知识库：ei-llm-wiki${kb.wiki?.head?.commit ? `@${kb.wiki.head.commit.slice(0, 7)}` : ''}`,
              kb.wiki?.head?.stale ? 'amber' : 'green',
            )
          : pill(kb.required === false ? '知识库不可用（降级评审）' : '知识库不可用：阻断', kb.required === false ? 'amber' : 'red'),
  );
  if (preflight.pullRequest.isDraft) items.push(pill('Draft：禁止状态性发布', 'amber'));
  return h('div', { class: 'context-strip' }, items);
}

function renderScopeEvidence(scope) {
  return h(
    'div',
    { class: 'content-card' },
    h('h3', {}, '范围识别依据'),
    scope.reason
      ? h('p', { class: 'muted' }, scope.reason)
      : scope.fallback
      ? h(
          'p',
          { class: 'muted' },
          '未找到 Team Seal 范围标记或标记未命中任何变更，本轮按「全部代码改动」评审。',
        )
      : h(
          'p',
          { class: 'muted' },
          `来源：${originLabel(scope.origin)}第 ${scope.markerLine ?? '—'} 行「${scope.marker}」`,
        ),
    scope.entries.length
      ? h(
          'ul',
          { class: 'muted' },
          scope.entries.map((entry) =>
            h(
              'li',
              {},
              h('code', {}, entry.raw),
              ` → ${entry.kind}：`,
              entry.matchedFiles.length ? entry.matchedFiles.join('、') : '未命中任何变更文件',
            ),
          ),
        )
      : null,
  );
}

function renderBlockers(preflight) {
  const nodes = [];
  for (const blocker of preflight.blockers) {
    nodes.push(
      notice(
        'error',
        h('strong', {}, `阻断：${blocker.message}`),
        blocker.remedy ? h('span', {}, ` ${blocker.remedy}`) : null,
      ),
    );
  }
  for (const warning of preflight.warnings) {
    nodes.push(notice('warning', h('strong', {}, '提醒：'), warning.message));
  }
  return nodes;
}

function renderAttribution(round) {
  if (!round?.attribution) return null;
  const { attribution } = round;
  return h(
    'div',
    { class: 'ai-attribution' },
    h('strong', {}, attribution.text),
    h('span', {}, attribution.context),
    attribution.knowledge ? h('span', {}, attribution.knowledge) : null,
    h('small', {}, attribution.humanState, attribution.demo ? ' · 演示数据，非真实评审结论' : ''),
  );
}

function renderFinding(finding, roundDetail) {
  const [label, tone] = SEVERITY_LABEL[finding.severity] ?? ['未知', 'gray'];
  const disabled = !roundDetail.freshness.fresh;

  const textarea = h('textarea', {
    rows: 4,
    value: finding.effectiveCommentEn,
    disabled,
    'aria-label': `英文评论正文：${finding.titleZh}`,
    oninput: (event) => saveFinding(finding.id, { commentEn: event.target.value }),
  });

  return h(
    'article',
    { class: `finding${finding.selected ? '' : ' excluded'}` },
    h(
      'div',
      { class: 'finding-top' },
      pill(label, tone),
      h(
        'label',
        { class: 'checkbox-label' },
        h('input', {
          type: 'checkbox',
          checked: finding.selected,
          disabled,
          onchange: async (event) => {
            await api.updateFinding(finding.id, { selected: event.target.checked });
            await actions.loadRound(roundDetail.round.id);
          },
        }),
        '发布此意见',
      ),
    ),
    h('h3', {}, finding.titleZh),
    h('p', {}, finding.detailZh),
    finding.wikiRefs?.length
      ? h(
          'p',
          { class: 'muted' },
          '知识库依据：',
          finding.wikiRefs.map((ref) => h('code', {}, `${ref} `)),
        )
      : null,
    finding.filePath
      ? h(
          'button',
          {
            class: 'location',
            type: 'button',
            onclick: () =>
              update({
                activeFile: finding.filePath,
                readingPane: 'diff',
                focusLine: {
                  filePath: finding.filePath,
                  newLine: finding.newLine,
                  oldLine: finding.oldLine,
                },
              }),
          },
          `${finding.filePath}:${finding.newLine ?? finding.oldLine}`,
        )
      : h('span', { class: 'muted' }, 'PR 级评论（无法行定位）'),
    h('label', { class: 'field-label' }, '英文评论正文', h('span', {}, '发布时附加固定 AI 署名')),
    textarea,
    h(
      'div',
      { class: 'finding-foot' },
      h('span', {}, `ID：${finding.key}`),
      h(
        'button',
        {
          class: 'button ghost small',
          type: 'button',
          disabled,
          onclick: async () => {
            await api.updateFinding(finding.id, { deleted: true, selected: false });
            toast('已删除人工草稿（不影响已发布的远端评论）');
            await actions.loadRound(roundDetail.round.id);
          },
        },
        '删除',
      ),
    ),
  );
}

function renderJiraPanel(preflight) {
  const issues = preflight.jiraSnapshot.issues ?? [];
  const manual = preflight.manualJiraKeys ?? [];
  const input = h('input', {
    class: 'search',
    type: 'text',
    placeholder: '补充 Jira key 或 URL，例如 SEAL-1042',
    'aria-label': '补充关联 Jira',
  });

  const addKey = () => {
    const raw = input.value.trim();
    if (!raw) return;
    const key = (raw.match(/[A-Za-z][A-Za-z0-9]+-\d+/)?.[0] ?? raw).toUpperCase();
    input.value = '';
    actions.saveJiraKeys([...new Set([...manual, key])]);
  };

  return h(
    'div',
    { class: 'content-card' },
    h('h3', {}, '关联需求'),
    h('p', { class: 'muted' }, '所有识别到的 issue 都会展示；系统不会替你从多个 issue 中任选其一。'),
    issues.length
      ? h(
          'ul',
          { class: 'muted' },
          issues.map((issue) =>
            h(
              'li',
              {},
              h('code', {}, issue.key),
              ` · 来源：${(issue.sources ?? []).map((item) => item.source).join('、') || '未知'}`,
              issue.error ? h('strong', {}, ` · 读取失败：${issue.error}`) : ` · ${issue.summary ?? ''}`,
              manual.includes(issue.key)
                ? h(
                    'button',
                    {
                      class: 'button ghost small',
                      type: 'button',
                      onclick: () =>
                        actions.saveJiraKeys(manual.filter((key) => key !== issue.key)),
                    },
                    '移除人工关联',
                  )
                : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, '尚未识别到关联 issue，可在下方人工补充。'),
    h(
      'div',
      { class: 'inline-form' },
      input,
      h('button', { class: 'button small', type: 'button', onclick: addKey }, '补充关联'),
    ),
  );
}

const CARRYOVER_LABEL = {
  still_present: ['仍存在', 'red'],
  fixed: ['已修复', 'green'],
  unverifiable: ['无法确认', 'amber'],
};

function renderCarryover(roundDetail) {
  const entries = roundDetail.carryover ?? [];
  if (!entries.length) return h('p', { class: 'muted' }, '这是该 PR 的第一轮评审，没有可比对的历史发现。');

  return h(
    'div',
    {},
    notice(
      'neutral',
      h('strong', {}, '跟踪说明：'),
      '本轮未再提及不代表已修复，系统只记为「无法确认」，由你判断。',
    ),
    entries.map((entry) => {
      const [label, tone] = CARRYOVER_LABEL[entry.verdict] ?? ['未知', 'gray'];
      return h(
        'div',
        { class: 'criterion' },
        pill(label, tone),
        h('strong', {}, `第 ${entry.previousRoundNumber} 轮 · ${entry.finding?.titleZh ?? entry.finding?.key}`),
        h(
          'p',
          { class: 'muted' },
          entry.finding?.filePath
            ? `${entry.finding.filePath}:${entry.finding.newLine ?? '—'} · ${entry.note ?? ''}`
            : entry.note ?? '',
        ),
        h(
          'label',
          { class: 'field-label' },
          '跟踪结论',
          h('span', {}, entry.decidedBy === 'user' ? '已由人工确认' : '系统自动判断'),
        ),
        h(
          'select',
          {
            'aria-label': `跟踪结论：${entry.finding?.titleZh ?? entry.id}`,
            onchange: (event) => actions.setCarryoverVerdict(entry.id, event.target.value),
          },
          Object.entries(CARRYOVER_LABEL).map(([value, [text]]) =>
            h('option', { value, selected: entry.verdict === value }, text),
          ),
        ),
      );
    }),
  );
}

/**
 * 知识库检索记录（FR-12）：引用已由后端对着本轮冻结的 checkout 逐条核对，
 * 这里如实展示查了什么、依据了哪些页面 —— 空引用同样要显示原因，不留想象空间。
 */
function renderWikiConsulted(roundDetail) {
  const kb = roundDetail.knowledgeBase;
  const wiki = roundDetail.wikiConsulted;
  if (!kb && !wiki) return null;

  if (!kb?.active) {
    return notice(
      'warning',
      h('strong', {}, '知识库：'),
      `本轮未使用 EI wiki 知识库${kb?.detail ? `（${kb.detail}）` : ''}，结论不含 wiki 依据。`,
    );
  }

  const refs = wiki?.references ?? [];
  return h(
    'div',
    { class: 'content-card' },
    h('h3', {}, '知识库依据（ei-llm-wiki）'),
    h(
      'p',
      { class: 'muted' },
      `版本 ${kb.commit ? kb.commit.slice(0, 12) : '未知'}`,
      wiki?.queries?.length ? ` · 检索关键词：${wiki.queries.join('、')}` : ' · 未记录检索关键词',
    ),
    refs.length
      ? h(
          'ul',
          { class: 'muted' },
          refs.map((ref) =>
            h('li', {}, h('code', {}, ref.path), ref.noteZh ? ` — ${ref.noteZh}` : ''),
          ),
        )
      : notice('warning', h('strong', {}, '未命中 wiki 页面：'), wiki?.noteZh || '（AI 未说明原因）'),
  );
}

function renderReportBody(roundDetail) {
  if (state.activeTab === 'carryover') return renderCarryover(roundDetail);

  if (state.activeTab === 'criteria') {
    const checks = roundDetail.criteriaChecks;
    if (!checks.length) return h('p', { class: 'muted' }, '本轮没有验收核对记录。');
    return h(
      'div',
      {},
      checks.map((check) => {
        const [label, tone] = VERDICT_LABEL[check.verdict] ?? ['未知', 'gray'];
        return h(
          'div',
          { class: 'criterion' },
          pill(label, tone),
          h('strong', {}, `${check.issueKey ?? ''} ${check.criterionId}`),
          h('p', {}, check.noteZh),
          check.needsHumanVerification
            ? h('p', { class: 'muted' }, '需要人工验证，不能计为已通过。')
            : null,
        );
      }),
    );
  }

  if (state.activeTab === 'log') {
    return h(
      'ul',
      { class: 'timeline' },
      roundDetail.events.map((event) =>
        h('li', {}, `${event.stage}：${event.message}`, h('small', {}, formatTime(event.createdAt))),
      ),
    );
  }

  const coverage = roundDetail.scopeCoverage;
  const findings = roundDetail.findings.filter((finding) => !finding.deleted);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'report-summary' },
      h('strong', {}, '中文摘要'),
      h('p', {}, roundDetail.summary.zh ?? '—'),
    ),
    coverage
      ? h(
          'p',
          { class: 'muted' },
          `已评审文件 ${coverage.reviewedFiles.length} 个 · 只读上下文 ${coverage.contextFiles.length} 个 · 未完成 ${coverage.notCovered.length} 个`,
        )
      : null,
    roundDetail.uncertainties?.length
      ? notice(
          'warning',
          h('strong', {}, '需人工验证：'),
          roundDetail.uncertainties.join('；'),
        )
      : null,
    renderWikiConsulted(roundDetail),
    findings.length
      ? findings.map((finding) => renderFinding(finding, roundDetail))
      : h('p', { class: 'muted' }, '本轮没有可发布的发现，「未发现」不等于已完整覆盖。'),
    h('label', { class: 'field-label' }, '英文总结（发布时附加署名）'),
    h('textarea', {
      rows: 4,
      value: roundDetail.summary.effectiveEn,
      disabled: !roundDetail.freshness.fresh,
      'aria-label': '英文总结',
      oninput: (event) =>
        saveSummary(roundDetail.round.id, { summaryEn: event.target.value }),
    }),
    h('label', { class: 'field-label' }, '英文覆盖理由', h('span', {}, '选择 Approve 覆盖 AI 建议时必填')),
    h('textarea', {
      rows: 3,
      value: roundDetail.summary.overrideReasonEn,
      disabled: !roundDetail.freshness.fresh,
      'aria-label': '英文覆盖理由',
      oninput: (event) =>
        saveSummary(roundDetail.round.id, { overrideReasonEn: event.target.value }),
    }),
  );
}

/** 连续重复的进度事件合并计数，避免多次模型调用看起来像卡住。 */
function collapseEvents(events) {
  const rows = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (last && last.message === event.message) {
      last.count += 1;
      last.createdAt = event.createdAt;
      continue;
    }
    rows.push({ message: event.message, createdAt: event.createdAt, count: 1 });
  }
  return rows;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function renderRunning(roundDetail) {
  const events = roundDetail.events ?? [];
  const stages = collapseEvents(events).slice(-6);
  const startedAt = roundDetail.round.startedAt ?? events[0]?.createdAt;
  const elapsed = startedAt ? formatElapsed(Date.now() - new Date(startedAt).getTime()) : '—';
  const lastAt = events[events.length - 1]?.createdAt;
  const idleMs = lastAt ? Date.now() - new Date(lastAt).getTime() : 0;

  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '✿'),
    h('h3', {}, '评审进行中'),
    h(
      'p',
      {},
      `本轮模型：${roundDetail.round.model.name} · 第 ${roundDetail.round.roundNumber} 轮 · 已运行 ${elapsed}`,
    ),
    h(
      'div',
      { class: 'progress-stages' },
      stages.map((stage, index) =>
        h(
          'div',
          { class: `stage${index === stages.length - 1 ? ' current' : ' done'}` },
          stage.count > 1 ? `${stage.message} ×${stage.count}` : stage.message,
          h('small', {}, formatTime(stage.createdAt)),
        ),
      ),
    ),
    idleMs > 90 * 1000
      ? h(
          'p',
          { class: 'muted' },
          `已有 ${formatElapsed(idleMs)} 没有新的进度事件；模型仍在思考属正常，超过 15 分钟会自动判定超时。`,
        )
      : null,
    h(
      'button',
      { class: 'button', type: 'button', onclick: () => actions.cancelReview() },
      '取消本轮',
    ),
  );
}

function renderReportPanel(roundDetail, preflight) {
  if (!roundDetail) {
    return h(
      'div',
      { class: 'report-panel' },
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '✽'),
        h('h3', {}, '尚未开始评审'),
        h(
          'p',
          {},
          preflight?.canStart
            ? '前置检查已通过，点击「开始评审」创建本轮任务。'
            : '前置检查未通过，请先按上方提示补齐信息。',
        ),
      ),
    );
  }

  const status = roundDetail.round.status;
  if (['preflight', 'running'].includes(status)) {
    return h('div', { class: 'report-panel' }, renderAttribution(roundDetail), renderRunning(roundDetail));
  }

  if (['failed', 'cancelled'].includes(status)) {
    return h(
      'div',
      { class: 'report-panel' },
      renderAttribution(roundDetail),
      h(
        'div',
        { class: 'report-body' },
        notice(
          'error',
          h('strong', {}, status === 'failed' ? '本轮评审失败：' : '本轮评审已取消：'),
          roundDetail.round.statusReason ?? '—',
          h('br'),
          '不完整的结果不能作为通过，也不能发布。可重新开始新一轮评审。',
        ),
        h(
          'ul',
          { class: 'timeline' },
          roundDetail.events.map((event) =>
            h('li', {}, `${event.stage}：${event.message}`, h('small', {}, formatTime(event.createdAt))),
          ),
        ),
      ),
    );
  }

  const tabs = [
    ['findings', '问题'],
    ['criteria', 'Jira 核对'],
    ['carryover', `上轮跟踪${roundDetail.carryover?.length ? `（${roundDetail.carryover.length}）` : ''}`],
    ['log', '运行记录'],
  ];

  return h(
    'div',
    { class: 'report-panel' },
    renderAttribution(roundDetail),
    roundDetail.round.status === 'closed_remote'
      ? notice(
          'neutral',
          h('strong', {}, '本轮已自动结束：'),
          `${roundDetail.round.statusReason ?? '你已在 Bitbucket 表态'}。报告仍可查看与发布，但不再算作待办。`,
        )
      : null,
    h(
      'div',
      { class: 'report-tabs', role: 'tablist' },
      tabs.map(([key, label]) =>
        h(
          'button',
          {
            class: `report-tab${state.activeTab === key ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': state.activeTab === key ? 'true' : 'false',
            onclick: () => update({ activeTab: key }),
          },
          label,
        ),
      ),
    ),
    h('div', { class: 'report-body' }, renderReportBody(roundDetail)),
  );
}

function renderWorkspace() {
  const preflight = state.preflight;
  if (state.preflightLoading) {
    return h('section', { class: 'review' }, h('div', { class: 'empty' }, h('p', {}, '正在读取 PR 上下文…')));
  }
  if (!preflight) {
    return h(
      'section',
      { class: 'review' },
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, '✿'),
        h('h3', {}, '请选择一个 PR'),
        h('p', {}, '左侧列表展示待你评审的 PR；选择后可查看范围、需求与代码差异。'),
      ),
    );
  }

  const pr = preflight.pullRequest;
  const roundDetail = state.round;
  const canPublish =
    roundDetail &&
    ['awaiting_confirmation', 'closed_remote'].includes(roundDetail.round.status) &&
    roundDetail.freshness.fresh;

  return h(
    'section',
    { class: 'review' },
    h(
      'div',
      { class: 'review-header' },
      h(
        'div',
        { class: 'review-title-row' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'meta-row' },
            h('span', {}, `#${pr.number}`),
            h('span', {}, pr.author?.name ?? '未知作者'),
            h('span', {}, formatTime(pr.updatedAt)),
            pr.isDraft ? pill('Draft', 'amber') : null,
            pill(
              `远端评审：${REMOTE_STATE_LABEL[pr.myReviewState] ?? pr.myReviewState}`,
              REMOTE_STATE_TONE[pr.myReviewState] ?? 'gray',
            ),
          ),
          h('h2', {}, pr.title),
          h(
            'div',
            { class: 'branch-row' },
            h('code', {}, pr.sourceBranch ?? '—'),
            h('span', {}, '→'),
            h('code', {}, pr.targetBranch ?? '—'),
            h('code', {}, `源 ${shortCommit(pr.sourceCommit)}`),
            h('code', {}, `目标 ${shortCommit(pr.targetCommit)}`),
          ),
        ),
        h(
          'button',
          {
            class: 'button primary',
            type: 'button',
            disabled: !preflight.canStart,
            title: preflight.canStart ? '创建新一轮评审' : '前置检查未通过',
            onclick: () => actions.startReview(),
          },
          state.rounds.length ? '重新评审' : '开始评审',
        ),
      ),
    ),
    renderScopeStrip(preflight),
    ...renderBlockers(preflight),
    roundDetail && !roundDetail.freshness.fresh
      ? notice('warning', h('strong', {}, '报告已过期：'), roundDetail.freshness.reason, '（只读，禁止发布）')
      : null,
    roundDetail
      ? h(
          'p',
          { class: 'muted', style: 'padding: 0 20px 12px' },
          `本轮模型：${roundDetail.round.model.name} · 新评审模型：${state.connection?.reviewModel?.name ?? '未配置'}`,
        )
      : null,
    h(
      'div',
      { class: 'pane-toggle', role: 'group', 'aria-label': '窄屏阅读区切换' },
      [
        ['diff', '代码差异'],
        ['report', '评审报告'],
      ].map(([value, label]) =>
        h(
          'button',
          {
            class: 'button small',
            type: 'button',
            'aria-pressed': (state.readingPane ?? 'diff') === value ? 'true' : 'false',
            onclick: () => update({ readingPane: value }),
          },
          label,
        ),
      ),
    ),
    h(
      'div',
      { class: `review-split show-${state.readingPane ?? 'diff'}` },
      state.diff
        ? renderDiff({
            files: state.diff.files,
            activeFile: state.activeFile,
            focusLine: state.focusLine,
            onSelectFile: (path) => update({ activeFile: path, focusLine: null }),
          })
        : h('div', { class: 'code-panel' }, h('p', { class: 'code-note' }, '正在加载差异…')),
      renderReportPanel(roundDetail, preflight),
    ),
    h(
      'div',
      { class: 'review-footer' },
      h(
        'p',
        {},
        h('strong', {}, '仅人工确认后发布'),
        '点击「预览发布」前不会产生任何远端写入。',
      ),
      h(
        'button',
        {
          class: 'button primary',
          type: 'button',
          disabled: !canPublish,
          onclick: () => openPublishDialog(roundDetail.round.id),
        },
        '预览发布 →',
      ),
    ),
    preflight.scope.found !== false ? renderScopeEvidence(preflight.scope) : null,
    renderJiraPanel(preflight),
  );
}

export function renderReviewPage() {
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-heading' },
      h(
        'div',
        {},
        h('span', { class: 'eyebrow' }, 'PR REVIEW'),
        h('h1', {}, 'PR 评审'),
        h('p', {}, `仓库 ${state.prs.repository} · 数据仅保存在本机`),
      ),
      h(
        'button',
        { class: 'button', type: 'button', onclick: () => actions.syncPrs() },
        state.loading ? '刷新中…' : '刷新',
      ),
    ),
    renderSummaryRow(state.prs.items),
    h('div', { class: 'workspace' }, renderPrList(state.prs.items), renderWorkspace()),
  );
}
