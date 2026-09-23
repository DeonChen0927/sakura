import { api } from './api.js';
import { toast } from './dom.js';

const listeners = new Set();

export const state = {
  route: '#/review',
  connection: null,
  prs: { items: [], repository: '', syncedAt: null, mode: 'mock' },
  search: '',
  filter: 'all',
  selectedPrId: null,
  preflight: null,
  preflightLoading: false,
  diff: null,
  round: null,
  rounds: [],
  activeTab: 'findings',
  activeFile: null,
  readingPane: 'diff',
  focusLine: null,
  history: [],
  models: null,
  identities: null,
  gitCache: null,
  loading: false,
  error: null,
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function update(patch) {
  Object.assign(state, patch);
  listeners.forEach((listener) => listener(state));
}

export async function guard(promise, message) {
  try {
    return await promise;
  } catch (error) {
    toast(message ? `${message}：${error.message}` : error.message);
    throw error;
  }
}

/**
 * 渲染期间的「只取一次」守卫：渲染函数是纯同步的，若直接发请求，
 * 请求回来更新 state 会再次触发渲染，形成无限拉取并冻结界面。
 * 这里按 key 记录已发起/已完成，失败也不自动重试（由页面上的刷新按钮显式重来）。
 */
const loadedOnce = new Set();

export function ensureLoaded(key, loader) {
  if (loadedOnce.has(key)) return;
  loadedOnce.add(key);
  Promise.resolve()
    .then(loader)
    .catch((error) => toast(`加载失败：${error.message}`));
}

export function invalidateLoaded(key) {
  loadedOnce.delete(key);
}

export const actions = {
  async bootstrap() {
    update({ loading: true });
    try {
      const data = await api.bootstrap();
      update({ connection: data.connection, prs: data.prs, loading: false });
      api
        .identities()
        .then((identities) => update({ identities }))
        .catch(() => {});
      if (!data.prs.syncedAt) await this.syncPrs();
    } catch (error) {
      update({ loading: false, error: error.message });
    }
  },

  async syncPrs() {
    update({ loading: true });
    try {
      const prs = await api.syncPrs();
      update({ prs, loading: false });
      toast(`已刷新 ${prs.items.length} 个待评审 PR`);
    } catch (error) {
      update({ loading: false });
      toast(`刷新失败：${error.message}`);
    }
  },

  /** 人工补充或移除关联 Jira（FR-04）；保存后立即重跑前置检查。 */
  async saveJiraKeys(keys) {
    if (!state.selectedPrId) return;
    try {
      const preflight = await api.saveJiraKeys(state.selectedPrId, keys);
      update({ preflight });
      toast('已更新关联需求，并重新执行前置检查');
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
  },

  async setCarryoverVerdict(id, verdict, note) {
    try {
      await api.setCarryoverVerdict(id, verdict, note);
      if (state.round) await this.loadRound(state.round.round.id);
    } catch (error) {
      toast(`更新跟踪结论失败：${error.message}`);
    }
  },

  async loadGitCache() {
    try {
      update({ gitCache: await api.gitCache() });
    } catch (error) {
      update({ gitCache: { error: error.message } });
    }
  },

  async selectPr(prId) {
    this.stopPolling();
    update({
      selectedPrId: prId,
      preflight: null,
      diff: null,
      round: null,
      rounds: [],
      activeFile: null,
      focusLine: null,
      preflightLoading: true,
    });
    try {
      const [preflight, rounds] = await Promise.all([api.preflight(prId), api.rounds(prId)]);
      update({
        preflight,
        rounds,
        preflightLoading: false,
        diff: preflight.diff,
        activeFile: preflight.diff.files[0]?.path ?? null,
      });
      const latest = rounds[0];
      if (latest) await this.loadRound(latest.id);
    } catch (error) {
      update({ preflightLoading: false });
      toast(`加载 PR 失败：${error.message}`);
    }
  },

  async loadRound(roundId) {
    try {
      const round = await api.round(roundId);
      update({ round });
      if (round.isRunning) this.pollRound(roundId);
    } catch (error) {
      toast(`读取评审轮次失败：${error.message}`);
    }
  },

  stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  },

  /**
   * 轮询绑定发起时的 PR：切换 PR 后旧轮询必须停下，
   * 否则回调会把上一个 PR 的轮次写进当前视图。
   */
  pollRound(roundId, prId = state.selectedPrId) {
    this.stopPolling();
    this.pollTimer = setTimeout(async () => {
      if (state.selectedPrId !== prId) return;
      try {
        const round = await api.round(roundId);
        if (state.selectedPrId !== prId) return;
        update({ round });
        const status = round.round.status;
        if (round.isRunning || ['preflight', 'running'].includes(status)) {
          this.pollRound(roundId, prId);
          return;
        }
        // 终态：无论成功、失败还是取消，都要把列表状态同步过来。
        if (status === 'awaiting_confirmation') toast('评审完成，待你确认');
        else if (status === 'failed') toast(`本轮评审失败：${round.round.statusReason ?? '未知原因'}`);
        else if (status === 'cancelled') toast(`本轮评审已取消：${round.round.statusReason ?? '—'}`);
        await this.refreshRounds();
      } catch (error) {
        toast(`轮询评审状态失败：${error.message}`);
      }
    }, 1200);
  },

  async refreshRounds() {
    if (!state.selectedPrId) return;
    const rounds = await api.rounds(state.selectedPrId);
    const prs = await api.prs();
    update({ rounds, prs });
  },

  async startReview() {
    if (!state.selectedPrId) return;
    try {
      const round = await api.startReview(state.selectedPrId);
      update({ round });
      toast(`已开始第 ${round.round.roundNumber} 轮评审`);
      this.pollRound(round.round.id);
      await this.refreshRounds();
    } catch (error) {
      const blockers = error.details?.blockers ?? [];
      toast(blockers.length ? `无法启动：${blockers[0].message}` : `无法启动：${error.message}`);
    }
  },

  async cancelReview() {
    if (!state.round) return;
    const roundId = state.round.round.id;
    const round = await guard(api.cancelRound(roundId), '取消失败');
    if (!round) return;
    update({ round });
    // 取消请求只是发出信号，子进程终止后状态才落到 cancelled，继续轮询到终态。
    if (round.isRunning || ['preflight', 'running'].includes(round.round.status)) {
      this.pollRound(roundId);
    } else {
      this.stopPolling();
      await this.refreshRounds();
    }
  },

  async setModel(model) {
    await guard(api.saveModel(model), '保存模型失败');
    const connection = await api.connectionStatus();
    update({ connection });
    toast(`新评审模型已保存：${model.name}（仅影响之后新建的轮次）`);
  },

  /** 登记模型后立即真实验证；CLI 不提供枚举，目录由用户维护。 */
  async addModel(model) {
    const result = await guard(api.addModel(model), '登记模型失败');
    if (!result) return;
    update({ models: { ...(state.models ?? {}), ok: true, models: result.models ?? [] } });
    toast(
      result.check?.status === 'available'
        ? `已登记并验证可用：${model.id}`
        : `已登记 ${model.id}，验证结果：${result.check?.detail ?? result.detail ?? '未确认'}`,
    );
  },

  async verifyModel(id) {
    const result = await guard(api.verifyModel(id), '验证模型失败');
    if (!result) return;
    update({ models: { ...(state.models ?? {}), ok: true, models: result.models ?? [] } });
    toast(result.check ? `${id}：${result.check.detail}` : `${id} 验证失败：${result.detail}`);
  },

  async removeModel(id) {
    await guard(api.removeModel(id), '删除模型失败');
    invalidateLoaded('settings-extras');
    await this.loadSettingsExtras();
    toast(`已从目录移除：${id}`);
  },

  async loadHistory() {
    const history = await api.history();
    update({ history: history.rounds });
  },

  async loadSettingsExtras() {
    // 身份探测要真实访问 Bitbucket 与 CLI，比模型目录慢得多；分别落盘，先到先显示。
    const modelsPromise = api.models().catch((error) => ({ ok: false, detail: error.message, models: [] }));
    const identitiesPromise = api.identities().catch((error) => ({ error: error.message }));
    update({ models: await modelsPromise });
    update({ identities: await identitiesPromise });
  },
};
