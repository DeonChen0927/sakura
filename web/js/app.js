import { h, clear, pill } from './dom.js';
import { state, update, subscribe, actions } from './state.js';
import { listModules, moduleByRoute } from './modules.js';

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  listModules().forEach((module, index) => {
    const active = state.route === module.route;
    nav.append(
      h(
        'a',
        {
          href: module.route,
          class: `nav-item${active ? ' active' : ''}`,
          'aria-current': active ? 'page' : null,
          title: `快捷键 ${index + 1}`,
        },
        h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, module.icon),
        module.name,
      ),
    );
  });
}

function renderChrome() {
  const module = moduleByRoute(state.route);
  const breadcrumb = document.getElementById('breadcrumb');
  clear(breadcrumb);
  module.breadcrumb.forEach((part, index) => {
    if (index > 0) breadcrumb.append(h('span', { 'aria-hidden': 'true' }, '/'));
    breadcrumb.append(h('span', {}, part));
  });

  const modePill = document.getElementById('mode-pill');
  clear(modePill);
  if (state.connection) {
    modePill.append(
      state.connection.demo ? pill('演示模式 · 数据为示例', 'demo') : pill('真实连接', 'green'),
    );
  }

  const profile = document.getElementById('profile');
  clear(profile);
  const identity = state.identities?.bitbucket;
  const name = identity?.displayName ?? '未连接';
  const handle = identity?.nickname ?? identity?.username;
  profile.append(
    h('div', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1)),
    h(
      'div',
      {},
      h('strong', {}, name),
      h(
        'small',
        {},
        handle ? `@${handle} · Bitbucket 身份` : identity?.detail ?? '请在连接设置中录入凭据',
      ),
    ),
  );
}

function renderPage() {
  const app = document.getElementById('app');
  clear(app);
  try {
    app.append(moduleByRoute(state.route).render());
  } catch (error) {
    app.append(
      h('div', { class: 'content-card' }, h('h2', {}, '页面渲染失败'), h('p', {}, error.message)),
    );
  }
}

function render() {
  renderNav();
  renderChrome();
  renderPage();
  document.title = `Sakura · ${moduleByRoute(state.route).name}`;
}

function applyHash() {
  const hash = window.location.hash || '#/review';
  const module = moduleByRoute(hash);
  if (module.route !== hash) window.location.hash = module.route;
  update({ route: module.route });
}

/** 关键操作的键盘入口（AC17）。 */
function bindShortcuts() {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const dialog = document.getElementById('publish-dialog');
      if (dialog?.open) dialog.close();
      return;
    }
    if (event.target.closest?.('input, textarea, select')) return;
    if (event.key === 'r') {
      event.preventDefault();
      actions.syncPrs();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector('input.search')?.focus();
      return;
    }
    const modules = listModules();
    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= modules.length) {
      window.location.hash = modules[index - 1].route;
    }
  });
}

/** 重新聚焦只提示数据可能过期，不后台自动启动 AI（FR-02）。 */
function bindFocusHint() {
  window.addEventListener('focus', () => {
    if (state.prs.syncedAt && !state.staleHint) update({ staleHint: true });
  });
}

subscribe(render);
window.addEventListener('hashchange', applyHash);

applyHash();
bindShortcuts();
bindFocusHint();
render();
actions.bootstrap();
