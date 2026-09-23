import { h, pill, notice, formatTime, toast } from '../dom.js';
import { api } from '../api.js';
import { state, update, actions, ensureLoaded } from '../state.js';

const CREDENTIALS = [
  ['bitbucket.token', 'Bitbucket 访问令牌', '用于读取 PR 与在人工确认后发布评论'],
  ['jira.token', 'Jira 访问令牌', '用于只读读取需求与验收标准'],
  [
    'copilot.token',
    'Copilot GitHub 令牌（可选）',
    '仅在本机 copilot CLI 自身未登录时需要；启动 CLI 时作为 COPILOT_GITHUB_TOKEN 注入',
  ],
];

const COPILOT_TOKEN_SOURCE = {
  sakura: 'Sakura 加密保存的 Token',
  environment: '启动进程的环境变量（换个终端启动可能失效）',
  cli_login: 'CLI 自身的登录态',
  demo: '演示模式',
};

async function reload() {  const connection = await api.connectionStatus();
  update({ connection });
}

function credentialCard(connection) {
  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, '凭据'),
    h('p', {}, `保护方式：${connection.credentialBackend}。Token 不在浏览器保存，也不进入日志、AI 提示或导出。`),
    CREDENTIALS.map(([name, label, hint]) => {
      const status = connection.credentials[name.split('.')[0]] ?? { present: false };
      const input = h('input', {
        class: 'search',
        type: 'password',
        autocomplete: 'off',
        placeholder: status.present ? '已保存，输入新值可覆盖' : '粘贴令牌后保存',
        'aria-label': label,
      });
      return h(
        'div',
        { style: 'margin-bottom:18px' },
        h('label', { class: 'field-label' }, label, h('span', {}, hint)),
        h('div', { class: 'setting-value' },
          status.present ? `已保存 · 更新于 ${formatTime(status.updatedAt)}` : '尚未录入'),
        input,
        h(
          'div',
          { style: 'display:flex;gap:8px;margin-top:8px' },
          h(
            'button',
            {
              class: 'button small',
              type: 'button',
              onclick: async () => {
                if (!input.value) return toast('请输入令牌');
                try {
                  await api.saveCredential(name, input.value);
                  input.value = '';
                  toast(`${label} 已保存到本机保护存储`);
                  await reload();
                } catch (error) {
                  toast(`保存失败：${error.message}${error.remedy ? `（${error.remedy}）` : ''}`);
                }
              },
            },
            '保存',
          ),
          status.present
            ? h(
                'button',
                {
                  class: 'button ghost small',
                  type: 'button',
                  onclick: async () => {
                    await api.removeCredential(name);
                    toast(`${label} 已删除`);
                    await reload();
                  },
                },
                '删除',
              )
            : null,
        ),
      );
    }),
  );
}

function modelStatusPill(item) {
  if (item.available === true) return pill('已验证可用', 'green');
  if (item.available === false) return pill('不可用', 'red');
  return pill('未验证', 'amber');
}

function modelCard(connection) {
  const model = connection.reviewModel;
  const options = state.models?.models ?? [];
  const source = state.models?.source ?? null;
  const idInput = h('input', { class: 'search', type: 'text', placeholder: '模型 ID，例如 claude-opus-5', 'aria-label': '模型 ID' });
  const nameInput = h('input', { class: 'search', type: 'text', placeholder: '显示名（可留空）', 'aria-label': '模型显示名' });

  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, 'Copilot CLI · 评审模型'),
    model.invalid
      ? notice('error', h('strong', {}, '模型配置无效：'), '请重新选择模型，系统不会静默重置。')
      : h(
          'div',
          { class: 'setting-value' },
          `当前：${model.name}（${model.id}）`,
          model.source === 'default' ? ' · 首次使用默认值' : ' · 已持久化',
        ),
    state.models && state.models.ok === false
      ? notice('error', h('strong', {}, '读取模型目录失败：'), state.models.detail ?? '未知原因')
      : null,
    source && source.enumerable === false ? notice('neutral', source.note) : null,
    options.length
      ? h(
          'ul',
          { class: 'model-list' },
          options.map((item) =>
            h(
              'li',
              { class: 'model-row' },
              h(
                'div',
                {},
                h('strong', {}, `${item.name}（${item.id}）`),
                item.id === model.id ? ' · 当前评审模型' : '',
                h('div', { class: 'help' }, item.detail ?? '尚未验证；启动评审前建议先验证。'),
                item.checkedAt ? h('div', { class: 'help' }, `验证于 ${formatTime(item.checkedAt)}`) : null,
              ),
              h(
                'div',
                { class: 'model-actions' },
                modelStatusPill(item),
                item.id === model.id
                  ? null
                  : h(
                      'button',
                      {
                        class: 'button small',
                        type: 'button',
                        onclick: () => actions.setModel({ id: item.id, name: item.name }),
                      },
                      '设为评审模型',
                    ),
                h(
                  'button',
                  { class: 'button small', type: 'button', onclick: () => actions.verifyModel(item.id) },
                  '验证',
                ),
                state.models?.demo
                  ? null
                  : h(
                      'button',
                      { class: 'button ghost small', type: 'button', onclick: () => actions.removeModel(item.id) },
                      '移除',
                    ),
              ),
            ),
          ),
        )
      : notice(
          'warning',
          h('strong', {}, '模型目录为空：'),
          '请在下方登记要使用的模型 ID 并验证。所选模型不可用时会明确阻止启动，不会自动改用其他模型。',
        ),
    state.models?.demo
      ? null
      : h(
          'div',
          { class: 'inline-form' },
          idInput,
          nameInput,
          h(
            'button',
            {
              class: 'button small',
              type: 'button',
              onclick: () => {
                const id = idInput.value.trim();
                if (!id) return toast('请填写模型 ID');
                actions.addModel({ id, name: nameInput.value.trim() || id });
                idInput.value = '';
                nameInput.value = '';
              },
            },
            '登记并验证',
          ),
        ),
    h(
      'p',
      { class: 'help' },
      '模型配置是用户级默认值，只影响之后新建的轮次；已创建、运行中的任务与历史报告保持原模型署名。',
    ),
    h(
      'button',
      {
        class: 'button small',
        type: 'button',
        onclick: () => actions.loadSettingsExtras(),
      },
      '重新读取模型与身份',
    ),
  );
}

function connectionCard(connection) {
  const identities = state.identities;
  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, '连接与身份'),
    h(
      'div',
      { class: 'setting-value' },
      `集成模式：${connection.mode}`,
      connection.demo ? ' · 演示数据，未连接真实服务' : ' · 真实连接',
    ),
    h('label', { class: 'field-label' }, '集成模式', h('span', {}, 'live 需要真实凭据与实例信息')),
    h(
      'select',
      {
        'aria-label': '集成模式',
        onchange: async (event) => {
          await api.saveSetting('connection.integrationMode', event.target.value);
          toast('集成模式已切换');
          await reload();
        },
      },
      ['mock', 'live'].map((value) =>
        h('option', { value, selected: connection.mode === value }, value === 'mock' ? 'mock（演示）' : 'live（真实）'),
      ),
    ),
    h(
      'div',
      { style: 'margin-top:16px;display:flex;gap:8px;flex-wrap:wrap' },
      ['bitbucket', 'jira', 'copilot'].map((target) =>
        h(
          'button',
          {
            class: 'button small',
            type: 'button',
            onclick: async () => {
              const result = await api.testConnection(target);
              toast(result.ok ? `${target} 连接正常：${result.detail}` : `${target} 连接失败（${result.kind}）：${result.detail}`);
            },
          },
          `测试 ${target}`,
        ),
      ),
    ),
    identities
      ? h(
          'div',
          { style: 'margin-top:16px' },
          h('p', { class: 'muted' }, 'Bitbucket 与 Copilot 是各自独立的身份，不能假设相同。'),
          h(
            'div',
            { class: 'setting-value' },
            `Bitbucket：${identities.bitbucket?.displayName ?? identities.bitbucket?.detail ?? '未知'}`,
          ),
          h(
            'div',
            { class: 'setting-value' },
            `Copilot：${identities.copilot?.account ?? identities.copilot?.version ?? identities.copilot?.detail ?? '未知'}`,
          ),
          identities.copilot?.loggedIn === false
            ? notice(
                'error',
                h('strong', {}, 'Copilot CLI 未认证：'),
                `${identities.copilot.authDetail ?? ''} 请在上方「凭据」里录入 Copilot GitHub 令牌，或在终端运行 copilot 后执行 /login。`,
              )
            : identities.copilot?.tokenSource
              ? h(
                  'div',
                  { class: 'setting-value' },
                  `Copilot 凭据来源：${COPILOT_TOKEN_SOURCE[identities.copilot.tokenSource] ?? identities.copilot.tokenSource}`,
                )
              : null,
        )
      : null,
  );
}

function jiraCard(connection) {
  const jira = connection.jira ?? {};
  const field = (key, label, hint) =>
    h(
      'div',
      {},
      h('label', { class: 'field-label' }, label, hint ? h('span', {}, hint) : null),
      h('input', {
        class: 'search',
        value: jira[key] ?? '',
        'aria-label': label,
        onchange: async (event) => {
          await api.saveSetting('connection.jira', { ...jira, [key]: event.target.value.trim() });
          toast('Jira 配置已保存');
          await reload();
        },
      }),
    );

  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, 'Jira'),
    notice('neutral', '实例类型（Cloud / Data Center）与验收标准字段 ID 仍待确认；字段必须显式配置，代码不猜测字段。'),
    field('baseUrl', '实例地址', 'https://your-instance'),
    field('email', '账号邮箱', '可留空；仅 Atlassian API token（Basic）才需要'),
    field('acceptanceFieldId', '验收标准字段 ID', '例如 customfield_10101'),
    h('label', { class: 'field-label' }, '认证方式', h('span', {}, '默认自动识别')),
    h(
      'select',
      {
        'aria-label': 'Jira 认证方式',
        onchange: async (event) => {
          await api.saveSetting('connection.jira', { ...jira, authScheme: event.target.value });
          await reload();
        },
      },
      [
        ['auto', '自动识别（推荐）'],
        ['bearer', 'Bearer：PAT / 访问令牌'],
        ['basic', 'Basic：邮箱 + API token'],
      ].map(([value, label]) =>
        h('option', { value, selected: (jira.authScheme ?? 'auto') === value }, label),
      ),
    ),
  );
}

function gitCacheCard() {
  const cache = state.gitCache;
  if (!cache) {
    ensureLoaded('git-cache', () => actions.loadGitCache());
    return h('section', { class: 'content-card' }, h('h2', {}, '本地 Git 缓存'), h('p', { class: 'muted' }, '正在读取…'));
  }

  const sizeMb = ((cache.sizeBytes ?? 0) / 1024 / 1024).toFixed(1);
  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, '本地 Git 缓存'),
    h(
      'p',
      { class: 'muted' },
      '优先使用你本机已有的仓库克隆作为只读上下文（只执行 cat-file / show，不 fetch、不切分支、不改动工作区）；本地没有对应提交时才回退到下面这个独立缓存。',
    ),
    h(
      'label',
      { class: 'field-label' },
      '本机仓库路径',
      h('span', {}, '留空则只用独立缓存，例如 D:\\dev\\ei-monorepo'),
    ),
    h('input', {
      class: 'search',
      value: cache.localSource?.path ?? '',
      placeholder: 'D:\\dev\\ei-monorepo',
      'aria-label': '本机仓库路径',
      onchange: async (event) => {
        await api.saveSetting('review.gitCache', {
          ...(cache.settings ?? {}),
          localSourcePath: event.target.value.trim(),
        });
        toast('本机仓库路径已保存');
        await actions.loadGitCache();
      },
    }),
    cache.localSource?.configured
      ? cache.localSource.ok
        ? notice('neutral', h('strong', {}, '本机仓库可用：'), `${cache.localSource.path}（只读）`)
        : notice('warning', h('strong', {}, '本机仓库不可用：'), cache.localSource.detail)
      : null,
    cache.error
      ? notice('error', cache.error)
      : h(
          'div',
          {},
          h('div', { class: 'setting-value' }, `目录：${cache.directory}`),
          h('div', { class: 'setting-value' }, `远端：${cache.remoteUrl || '未配置'}（不含任何 Token）`),
          h(
            'div',
            { class: 'setting-value' },
            cache.exists ? `已建立缓存，占用约 ${sizeMb} MB` : '尚未建立缓存',
          ),
          cache.git?.ok
            ? h('div', { class: 'setting-value' }, cache.git.version)
            : notice('warning', h('strong', {}, 'git 不可用：'), cache.git?.detail ?? '未检测到 git'),
          cache.mode !== 'live'
            ? notice('neutral', '演示模式不拉取真实仓库；切换到 live 并录入凭据后才会使用缓存。')
            : null,
        ),
    h(
      'div',
      { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' },
      h(
        'button',
        { class: 'button small', type: 'button', onclick: () => actions.loadGitCache() },
        '刷新状态',
      ),
      h(
        'button',
        {
          class: 'button ghost small',
          type: 'button',
          disabled: !cache.exists,
          onclick: async () => {
            const preview = await api.clearGitCache(false);
            const mb = ((preview.preview.sizeBytes ?? 0) / 1024 / 1024).toFixed(1);
            if (!window.confirm(`将删除 ${preview.preview.directory}（约 ${mb} MB），确认清理？`)) return;
            await api.clearGitCache(true);
            toast('已清理本地 Git 缓存');
            await actions.loadGitCache();
          },
        },
        '清理缓存',
      ),
    ),
  );
}

function bitbucketCard(connection) {
  const bitbucket = connection.bitbucket ?? {};
  const save = async (patch) => {
    await api.saveSetting('connection.bitbucket', { ...bitbucket, ...patch });
    toast('Bitbucket 连接配置已保存');
    await reload();
  };

  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, 'Bitbucket'),
    notice(
      'neutral',
      h('strong', {}, '通常只需录入 token：'),
      '默认自动识别认证方式 —— 先按 Bearer（访问令牌 / OAuth）尝试；若你用的是 Atlassian 账号 API token，再额外填写下面的账号邮箱即可（Basic）。',
    ),
    h('label', { class: 'field-label' }, '仓库', h('span', {}, 'workspace/repository')),
    h('input', {
      class: 'search',
      value: connection.repository,
      'aria-label': 'Bitbucket 仓库',
      onchange: async (event) => {
        await api.saveSetting('connection.repository', event.target.value.trim());
        toast('仓库已更新');
        await reload();
      },
    }),
    h('label', { class: 'field-label' }, '认证方式', h('span', {}, '默认自动识别')),
    h(
      'select',
      {
        'aria-label': 'Bitbucket 认证方式',
        onchange: (event) => save({ authScheme: event.target.value }),
      },
      [
        ['auto', '自动识别（推荐）'],
        ['bearer', 'Bearer：访问令牌 / OAuth'],
        ['basic', 'Basic：邮箱 + API token'],
      ].map(([value, label]) =>
        h('option', { value, selected: (bitbucket.authScheme ?? 'auto') === value }, label),
      ),
    ),
    bitbucket.authScheme !== 'bearer'
      ? h(
          'div',
          {},
          h(
            'label',
            { class: 'field-label' },
            'Atlassian 账号邮箱',
            h('span', {}, '可留空；仅 Atlassian API token 需要'),
          ),
          h('input', {
            class: 'search',
            value: bitbucket.email ?? '',
            'aria-label': 'Atlassian 账号邮箱',
            onchange: (event) => save({ email: event.target.value.trim() }),
          }),
        )
      : null,
    h('label', { class: 'field-label' }, 'API 基地址'),
    h('input', {
      class: 'search',
      value: bitbucket.apiBase ?? '',
      'aria-label': 'Bitbucket API 基地址',
      onchange: (event) => save({ apiBase: event.target.value.trim() }),
    }),
    h(
      'label',
      { class: 'checkbox-label', style: 'margin-top:12px' },
      h('input', {
        type: 'checkbox',
        checked: bitbucket.includeDrafts !== false,
        onchange: (event) => save({ includeDrafts: event.target.checked }),
      }),
      '列表包含 Draft PR（可阅读与评审，但禁止状态性发布）',
    ),
  );
}

function teamRosterCard(connection) {
  // 后端没返回这个字段 = 服务进程比前端旧（改完代码没重启）。
  // 这和「名单读不到」是两回事，必须分开说：否则会照着提示去查 teams.yaml，
  // 而文件其实完全正常，白查一轮。
  if (!connection.teamRoster) {
    return h(
      'section',
      { class: 'content-card' },
      h('h2', {}, '团队名单'),
      notice(
        'warning',
        h('strong', {}, '后端版本过旧：'),
        '当前运行的 Sakura 服务进程还不支持团队名单（接口未返回该字段），因此无法显示或修改配置。请重启本地服务（Ctrl+C 后重新 npm start）。',
      ),
    );
  }

  const roster = connection.teamRoster;
  const settings = roster.settings ?? { path: '', team: 'Seal' };
  const save = async (patch) => {
    await api.saveSetting('review.teamRoster', { ...settings, ...patch });
    toast('团队名单配置已保存');
    await reload();
  };

  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, '团队名单'),
    h(
      'p',
      { class: 'muted' },
      '由你本人、或名单中的团队成员发起的 PR，一律按全部变更文件评审，不套用 Codeowner Bot 的 Team Seal 范围——那个范围是给外部团队的改动划界的。',
    ),
    h(
      'label',
      { class: 'field-label' },
      'teams.yaml 路径',
      h('span', {}, '留空则取「本地 Git 缓存」里填的本机仓库路径 + teams.yaml'),
    ),
    h('input', {
      class: 'search',
      value: settings.path ?? '',
      placeholder: 'D:\\dev\\ei-monorepo\\teams.yaml',
      'aria-label': 'teams.yaml 路径',
      onchange: (event) => save({ path: event.target.value.trim() }),
    }),
    h('label', { class: 'field-label' }, '团队名称'),
    h('input', {
      class: 'search',
      value: settings.team ?? 'Seal',
      placeholder: 'Seal',
      'aria-label': '团队名称',
      onchange: (event) => save({ team: event.target.value.trim() }),
    }),
    roster.ok
      ? notice(
          'neutral',
          h('strong', {}, `${roster.team} 团队名单可用：`),
          `${roster.memberCount} 名成员 · ${roster.path}`,
        )
      : notice(
          'warning',
          h('strong', {}, '名单不可用：'),
          `${roster.detail ?? '后端没有给出原因，请查看本地服务日志。'}${roster.remedy ? ` ${roster.remedy}` : ''}`,
          ' 此时团队成员发起的 PR 会退回按 Team Seal 范围评审，评审范围可能偏小。',
        ),
  );
}

/**
 * 知识库（FR-12）：PR 评审必须经 ei-ai-skills 的 ei-llm-wiki skill 使用 EI 工程 wiki。
 * 不可用时默认阻断评审 —— 静默退化成「只看 diff」的报告看起来一样完整，实则少了判断依据。
 */
function knowledgeBaseCard(connection) {
  if (!connection.knowledgeBase) {
    return h(
      'section',
      { class: 'content-card' },
      h('h2', {}, '评审知识库'),
      notice(
        'warning',
        h('strong', {}, '后端版本过旧：'),
        '当前运行的 Sakura 服务进程还不支持知识库配置（接口未返回该字段）。请重启本地服务（Ctrl+C 后重新 npm start）。',
      ),
    );
  }

  const kb = connection.knowledgeBase;
  const settings = kb.settings ?? {};
  const save = async (patch) => {
    await api.saveSetting('review.knowledgeBase', { ...settings, ...patch });
    toast('知识库配置已保存');
    await reload();
  };

  const head = kb.wiki?.head ?? null;
  return h(
    'section',
    { class: 'content-card' },
    h('h2', {}, '评审知识库'),
    h(
      'p',
      { class: 'muted' },
      '评审通过 ei-ai-skills 插件的 ei-llm-wiki skill 读取 EI 工程 wiki：子系统怎么工作、某个决定为什么这么定、历史缺陷留下过什么教训，只看 diff 得不出这些结论。wiki 只需要克隆一次，Sakura 会在首次评审前自动完成，之后按需刷新并以只读方式挂载，评审子进程不执行任何 git 命令。',
    ),
    h(
      'label',
      { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: settings.enabled !== false,
        onchange: (event) => save({ enabled: event.target.checked }),
      }),
      '评审时使用 ei-llm-wiki 知识库',
    ),
    h(
      'label',
      { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: settings.required !== false,
        disabled: settings.enabled === false,
        onchange: (event) => save({ required: event.target.checked }),
      }),
      '知识库不可用时阻断评审（关闭后会降级为只看代码与需求，并在报告中标注）',
    ),
    h(
      'label',
      { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: settings.autoClone !== false,
        disabled: settings.enabled === false,
        onchange: (event) => save({ autoClone: event.target.checked }),
      }),
      `本机没有 checkout 时自动克隆一次到 ${kb.managedPath ?? 'data/knowledge-base'}`,
    ),
    h(
      'label',
      { class: 'field-label' },
      'ei-llm-wiki checkout 路径',
      h(
        'span',
        {},
        '留空则按顺序查找：EI_LLM_WIKI_REPO → %APPDATA%/ei-ai-skills/ei-llm-wiki.json → Sakura 托管目录；都没有就自动克隆。已有 checkout 时填在这里可以复用，不会重复占磁盘。',
      ),
    ),
    h('input', {
      class: 'search',
      value: settings.wikiRepoPath ?? '',
      placeholder: 'D:\\dev\\ei-llm-wiki',
      'aria-label': 'ei-llm-wiki checkout 路径',
      onchange: (event) => save({ wikiRepoPath: event.target.value.trim() }),
    }),
    h(
      'label',
      { class: 'field-label' },
      'ei-ai-skills 插件目录',
      h('span', {}, '留空则自动查找 ~/.copilot/installed-plugins/ei-ai-skills'),
    ),
    h('input', {
      class: 'search',
      value: settings.pluginPath ?? '',
      placeholder: 'C:\\Users\\you\\.copilot\\installed-plugins\\ei-ai-skills\\ei-llm-wiki',
      'aria-label': 'ei-ai-skills 插件目录',
      onchange: (event) => save({ pluginPath: event.target.value.trim() }),
    }),
    kb.enabled === false
      ? notice('warning', '知识库已关闭：评审不会检索 wiki，结论可能与既有设计约定冲突而不自知。')
      : kb.available
        ? notice(
            'neutral',
            h('strong', {}, '知识库可用：'),
            `${kb.wiki.path}${head?.commit ? `@${head.commit.slice(0, 12)}` : ''}`,
            kb.wiki?.managed ? ' · Sakura 自动克隆' : '',
            head?.branch ? ` · 分支 ${head.branch}` : '',
            head?.ageDays !== null && head?.ageDays !== undefined
              ? ` · 最后提交 ${head.ageDays} 天前`
              : '',
            kb.plugin?.path ? h('br', {}) : null,
            kb.plugin?.path ? `插件：${kb.plugin.path}` : null,
          )
        : notice(
            'warning',
            h('strong', {}, '知识库不可用：'),
            `${kb.detail ?? '未知原因'}${kb.remedy ? ` ${kb.remedy}` : ''}`,
          ),
    kb.demo ? notice('neutral', '演示模式不会实际调用知识库；切换到 live 后才会挂载。') : null,
    kb.provision && kb.provision.ok === false
      ? notice(
          'warning',
          h('strong', {}, '自动克隆失败：'),
          `${kb.provision.detail}（远端 ${kb.provision.remote}）。若是 SSH 鉴权问题，请先配置 Bitbucket SSH key 并确认有 ei-llm-wiki 读权限，再点下方刷新重试。`,
        )
      : null,
    head?.stale
      ? notice('warning', `checkout 最后一次提交在 ${head.ageDays} 天前，建议先刷新再评审。`)
      : null,
    kb.wiki?.refresh
      ? notice(kb.wiki.refresh.ok ? 'neutral' : 'warning', `刷新结果：${kb.wiki.refresh.detail}`)
      : null,
    kb.wiki?.canonicalSkills?.length
      ? h(
          'div',
          { class: 'setting-value' },
          `checkout 内可用的 canonical skill：${kb.wiki.canonicalSkills.map((item) => item.name).join('、')}`,
        )
      : null,
    h(
      'div',
      { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' },
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          disabled: !kb.wiki?.ok,
          onclick: async () => {
            toast('正在刷新知识库（git fetch）…');
            try {
              await api.refreshKnowledgeBase();
              toast('知识库已刷新');
              await reload();
            } catch (error) {
              toast(`刷新失败：${error.message}`);
            }
          },
        },
        '刷新知识库',
      ),
    ),
  );
}

export function renderSettingsPage() {
  const connection = state.connection;
  if (!connection) return h('p', { class: 'muted' }, '正在读取连接状态…');
  if (!state.models) ensureLoaded('settings-extras', () => actions.loadSettingsExtras());

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-heading' },
      h(
        'div',
        {},
        h('span', { class: 'eyebrow' }, 'CONNECTIONS'),
        h('h1', {}, '连接设置'),
        h('p', {}, '服务只监听 127.0.0.1；变更请求需要本地会话与 CSRF 校验。'),
      ),
      connection.demo ? pill('演示模式', 'demo') : pill('真实连接', 'green'),
    ),
    h(
      'div',
      { class: 'settings-grid' },
      connectionCard(connection),
      bitbucketCard(connection),
      jiraCard(connection),
      modelCard(connection),
      credentialCard(connection),
      gitCacheCard(),
      teamRosterCard(connection),
      knowledgeBaseCard(connection),
    ),
  );
}
