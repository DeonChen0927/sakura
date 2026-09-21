import { renderReviewPage } from './views/review.js';
import { renderHistoryPage } from './views/history.js';
import { renderSettingsPage } from './views/settings.js';

/**
 * 模块注册入口（FR-09）。
 * 每个模块包含 ID、名称、图标、路由与页面；新增功能区只需在此注册，导航与路由自动生效。
 */
const modules = new Map();

export function registerModule(module) {
  if (!module?.id || !module.route || typeof module.render !== 'function') {
    throw new Error('模块必须包含 id、route 与 render');
  }
  modules.set(module.id, {
    icon: '✿',
    breadcrumb: ['工作台', module.name],
    ...module,
  });
  return module;
}

export const listModules = () => [...modules.values()];

export const moduleByRoute = (route) =>
  listModules().find((item) => item.route === route) ?? listModules()[0];

registerModule({
  id: 'pr-review',
  name: 'PR 评审',
  icon: '❀',
  route: '#/review',
  render: renderReviewPage,
});

registerModule({
  id: 'review-history',
  name: '评审历史',
  icon: '⟳',
  route: '#/history',
  render: renderHistoryPage,
});

registerModule({
  id: 'connections',
  name: '连接设置',
  icon: '⚙',
  route: '#/settings',
  render: renderSettingsPage,
});
