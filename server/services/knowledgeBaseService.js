import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { paths } from '../config.js';
import { settingsService, SettingKey } from './settingsService.js';
import {
  WIKI_MARKER_FILES,
  RESOLVER_SKILL_NAME,
  CANONICAL_SKILL_GLOB_DIR,
  parseSkillFrontmatter,
  normalizeWikiPath,
} from '../domain/knowledgeBase.js';
import { logger } from '../lib/logger.js';

/**
 * 知识库服务（FR-12）。
 *
 * PR 评审必须使用 `ei-ai-skills` 插件的 `ei-llm-wiki` skill，把 EI 工程 wiki 当知识库。
 * wiki 本身是一个 git 仓库，"clone 一次，之后就只是个文件夹"；但评审子进程里 shell 被禁用
 * 且不允许反问用户（FR-05），skill 自带的 clone / 追问流程在这里跑不起来。
 * 所以由后端替它完成这一次性准备，再把结果以只读方式交给 CLI：
 *
 * - 解析顺序与 skill 一致，末尾追加 Sakura 自己托管的 checkout；
 * - 都没有时自动 clone 到 data/knowledge-base，不需要用户预先准备；
 * - 用户已有 checkout 时优先用它，刷新只做 fetch + 可快进的 merge，
 *   工作树不干净或不在 main 上一律不动（那是用户的仓库，不是 Sakura 的缓存）。
 */

const CONFIG_RELATIVE = path.join('ei-ai-skills', 'ei-llm-wiki.json');
const STALE_DAYS = 14;
const GIT_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WIKI_REMOTE = 'git@bitbucket.org:agfahealthcare/ei-llm-wiki.git';
const MANAGED_DIR_NAME = 'ei-llm-wiki';
/** clone 失败后的冷却时间：避免每次前置检查都去撞一次网络/鉴权错误 */
const CLONE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

let cache = null;
let lastCloneAttempt = null;
let clonePromise = null;

/** 非交互 git 环境：任何需要输入口令/确认 host key 的场景都必须立即失败而不是挂住。 */
function gitEnv() {
  const sshCommand =
    process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand };
}

function runGitRaw(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? error?.message ?? '').trim(),
        });
      },
    );
  });
}

function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return runGitRaw(['-C', cwd, ...args], { timeoutMs });
}

/** Sakura 托管的 checkout 路径；用户没有自己的 checkout 时 clone 到这里。 */
export function managedCheckoutPath() {
  return path.join(paths.knowledgeBase, MANAGED_DIR_NAME);
}

function wikiRemote(settings) {
  const configured = String(settings?.remote ?? '').trim();
  return configured || DEFAULT_WIKI_REMOTE;
}

/** 每用户配置文件路径，与 skill 文档一致（Windows 走 %APPDATA%）。 */
export function userConfigPath() {
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, CONFIG_RELATIVE);
  return path.join(os.homedir(), '.ei-ai-skills', 'ei-llm-wiki.json');
}

function readUserConfig() {
  const file = userConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repo = String(parsed?.wiki_repo ?? '').trim();
    return repo ? { path: path.resolve(repo), file } : null;
  } catch {
    return null;
  }
}

/** checkout 合法性：三个标志文件缺一不可，避免把任意目录当成 wiki。 */
function checkoutProblem(dir) {
  if (!dir) return '未提供路径';
  if (!fs.existsSync(dir)) return `路径不存在：${dir}`;
  const missing = WIKI_MARKER_FILES.filter((file) => !fs.existsSync(path.join(dir, ...file.split('/'))));
  if (missing.length) return `目录不是 ei-llm-wiki checkout，缺少：${missing.join('、')}`;
  return null;
}

/** 插件目录合法性：必须能找到 ei-llm-wiki 这个 skill 的 SKILL.md。 */
function pluginSkillFile(dir) {
  return path.join(dir, 'skills', RESOLVER_SKILL_NAME, 'SKILL.md');
}

function defaultPluginCandidates() {
  const home = os.homedir();
  const root = path.join(home, '.copilot', 'installed-plugins', 'ei-ai-skills');
  const candidates = [path.join(root, 'ei-llm-wiki')];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (!candidates.includes(full)) candidates.push(full);
    }
  } catch {
    // 插件根目录不存在：候选保持为默认路径，下面会如实报告未安装
  }
  return candidates;
}

function resolvePlugin(configuredPath) {
  const configured = String(configuredPath ?? '').trim();
  const candidates = configured ? [path.resolve(configured)] : defaultPluginCandidates();
  for (const candidate of candidates) {
    const skillFile = pluginSkillFile(candidate);
    if (!fs.existsSync(skillFile)) continue;
    const manifest = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    return {
      ok: true,
      path: candidate,
      source: configured ? 'setting' : 'default',
      skill: manifest?.name ?? RESOLVER_SKILL_NAME,
      description: manifest?.description ?? '',
      detail: `已找到 ei-ai-skills 插件的 ${manifest?.name ?? RESOLVER_SKILL_NAME} skill。`,
    };
  }
  return {
    ok: false,
    path: configured ? path.resolve(configured) : candidates[0] ?? null,
    source: configured ? 'setting' : 'default',
    skill: null,
    detail: configured
      ? `配置的插件目录里没有 skills/${RESOLVER_SKILL_NAME}/SKILL.md`
      : '本机没有安装 ei-ai-skills 插件（未在 ~/.copilot/installed-plugins/ei-ai-skills 下找到 ei-llm-wiki skill）。',
    remedy:
      '请安装 ei-ai-skills 插件，或在「连接设置 → 知识库」直接填写插件目录（该目录下应有 skills/ei-llm-wiki/SKILL.md）。',
  };
}

/** 解析 wiki checkout：设置 → 环境变量 → 每用户配置文件 → Sakura 托管目录。 */
function resolveWikiPath(configuredPath) {
  const configured = String(configuredPath ?? '').trim();
  const attempts = [];
  if (configured) attempts.push({ path: path.resolve(configured), source: 'setting' });
  const env = String(process.env.EI_LLM_WIKI_REPO ?? '').trim();
  if (env) attempts.push({ path: path.resolve(env), source: 'env' });
  const fromConfig = readUserConfig();
  if (fromConfig) attempts.push({ path: fromConfig.path, source: 'config', file: fromConfig.file });
  // 最后才用自己托管的副本：用户已有 checkout 时永远优先复用，不重复占磁盘。
  attempts.push({ path: managedCheckoutPath(), source: 'managed' });

  const rejected = [];
  for (const attempt of attempts) {
    const problem = checkoutProblem(attempt.path);
    if (!problem) return { ok: true, ...attempt };
    if (attempt.source !== 'managed') rejected.push(`${attempt.source}：${problem}`);
  }

  return {
    ok: false,
    path: attempts[0]?.path ?? null,
    source: attempts[0]?.source ?? null,
    managedPath: managedCheckoutPath(),
    detail: rejected.length
      ? `没有找到可用的 ei-llm-wiki checkout（${rejected.join('；')}）`
      : '本机还没有 ei-llm-wiki checkout，Sakura 会在开始评审前自动克隆一次。',
    remedy:
      '自动克隆需要可用的 Bitbucket SSH key（https://bitbucket.org/account/settings/ssh-keys/）与 ei-llm-wiki 读权限。' +
      '也可以在「连接设置 → 知识库」直接填写已有 checkout 路径复用它。',
  };
}

/** 读取 checkout 的版本信息；git 不可用时只做降级展示，不阻断。 */
async function readHead(dir) {
  const [commit, branch, status, date] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], dir, 20_000),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, 20_000),
    runGit(['status', '--porcelain'], dir, 30_000),
    runGit(['log', '-1', '--format=%cI'], dir, 20_000),
  ]);
  const committedAt = date.ok && date.stdout ? date.stdout : null;
  const ageDays = committedAt
    ? Math.floor((Date.now() - new Date(committedAt).getTime()) / (24 * 3600 * 1000))
    : null;
  return {
    commit: commit.ok ? commit.stdout : null,
    branch: branch.ok ? branch.stdout : null,
    clean: status.ok ? status.stdout.length === 0 : null,
    committedAt,
    ageDays,
    stale: ageDays !== null && ageDays > STALE_DAYS,
    gitDetail: commit.ok ? null : commit.stderr || 'git 不可用，无法读取 checkout 版本',
  };
}

/** 读取 checkout 里的 canonical skill 清单，用于界面展示知识库的真实能力来源。 */
function readCanonicalSkills(dir) {
  const root = path.join(dir, ...CANONICAL_SKILL_GLOB_DIR.split('/'));
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const file = path.join(root, entry.name, 'SKILL.md');
        if (!fs.existsSync(file)) return null;
        const manifest = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
        return manifest ? { name: manifest.name, description: manifest.description } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const knowledgeBaseService = {
  settings() {
    return settingsService.get(SettingKey.KNOWLEDGE_BASE) ?? {};
  },

  /**
   * 知识库状态。默认读缓存（一次评审流程里会被多处调用），
   * refresh=true 时真的跑 git fetch 并尝试快进。
   */
  async status({ refresh = false } = {}) {
    const settings = this.settings();
    const enabled = settings.enabled !== false;
    const required = settings.required !== false;
    // 演示模式不挂载真实知识库：mock 适配器根本不会调用 CLI。路径解析照做，
    // 这样设置页在演示模式下也能提前发现配置问题，只是本轮不会激活。
    const demo = settingsService.integrationMode() !== 'live';
    const cacheKey = JSON.stringify({ settings, demo });

    if (!enabled) {
      return {
        enabled: false,
        required,
        active: false,
        available: false,
        settings,
        skill: RESOLVER_SKILL_NAME,
        detail: '知识库已在设置中关闭，本轮评审不会检索 ei-llm-wiki。',
      };
    }

    if (!refresh && cache?.key === cacheKey) return cache.value;

    const plugin = resolvePlugin(settings.pluginPath);
    const wiki = resolveWikiPath(settings.wikiRepoPath);

    let head = null;
    let refreshResult = null;
    if (wiki.ok) {
      if (refresh) refreshResult = await this.refreshCheckout(wiki.path);
      head = await readHead(wiki.path);
    }

    const available = plugin.ok && wiki.ok;
    const autoClone = settings.autoClone !== false;
    const value = {
      enabled: true,
      required,
      demo,
      active: available && !demo,
      available,
      autoClone,
      remote: wikiRemote(settings),
      managedPath: managedCheckoutPath(),
      provision: lastCloneAttempt,
      settings,
      skill: RESOLVER_SKILL_NAME,
      plugin,
      wiki: wiki.ok
        ? {
            ok: true,
            path: wiki.path,
            source: wiki.source,
            managed: wiki.source === 'managed',
            configFile: wiki.file ?? null,
            head,
            canonicalSkills: readCanonicalSkills(wiki.path),
            refresh: refreshResult,
          }
        : {
            ok: false,
            path: wiki.path,
            source: wiki.source,
            detail: wiki.detail,
            remedy: wiki.remedy,
            canAutoClone: autoClone,
          },
      detail: available
        ? `知识库就绪：${wiki.path}${head?.commit ? `@${head.commit.slice(0, 12)}` : ''}${
            wiki.source === 'managed' ? '（Sakura 自动克隆）' : ''
          }${demo ? '；演示模式不会实际调用它' : ''}`
        : [
            plugin.ok ? null : plugin.detail,
            wiki.ok ? null : wiki.detail,
            lastCloneAttempt?.ok === false ? `上次自动克隆失败：${lastCloneAttempt.detail}` : null,
          ]
            .filter(Boolean)
            .join('；'),
      remedy: available ? null : [plugin.remedy, wiki.remedy].filter(Boolean).join(' '),
    };

    cache = { key: cacheKey, value };
    return value;
  },

  /**
   * 评审前调用：状态不可用且只差 checkout 时，自动克隆一次再重新判定。
   *
   * wiki 是「clone 一次之后就只是个文件夹」的东西，没有理由让用户先去手工准备；
   * 但评审子进程禁了 shell 也不能反问用户，所以这一次性动作必须由后端做。
   * 插件缺失不在这里补 —— 那是 CLI 插件安装，属于用户环境，不该由 Sakura 偷偷改动。
   */
  async ensure({ refresh = false } = {}) {
    let status = await this.status({ refresh });
    if (!status.enabled || status.demo || status.available) return status;
    if (status.autoClone === false || !status.plugin?.ok) return status;

    const provisioned = await this.provisionManagedCheckout(status.remote);
    if (!provisioned.attempted) return status;

    this.invalidate();
    status = await this.status();
    return status;
  },

  /**
   * 克隆托管 checkout。并发去重，失败后进入冷却，避免每次前置检查都重撞鉴权错误。
   * 目标目录必须为空或不存在，绝不覆盖已有内容。
   */
  async provisionManagedCheckout(remote = wikiRemote(this.settings())) {
    const target = managedCheckoutPath();
    if (clonePromise) return clonePromise;
    if (
      lastCloneAttempt &&
      lastCloneAttempt.ok === false &&
      Date.now() - new Date(lastCloneAttempt.at).getTime() < CLONE_RETRY_COOLDOWN_MS
    ) {
      return { attempted: false, ...lastCloneAttempt };
    }

    clonePromise = (async () => {
      try {
        if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
          // 目录有内容却没通过 checkout 校验：可能是半途失败的 clone。
          // 不自动删除用户数据目录里的东西，如实报告让人来处理。
          const detail = `${target} 已存在但不是有效的 ei-llm-wiki checkout，为避免覆盖不做自动克隆。`;
          lastCloneAttempt = { ok: false, at: new Date().toISOString(), target, remote, detail };
          return { attempted: true, ...lastCloneAttempt };
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        logger.info(`知识库：开始克隆 ${remote} → ${target}`);
        const cloned = await runGitRaw(['clone', remote, target], { timeoutMs: CLONE_TIMEOUT_MS });
        if (!cloned.ok) {
          // 留下半成品目录会让下一次 clone 永远进不去，这里只清理确认由本次创建的目录
          try {
            if (fs.existsSync(path.join(target, '.git'))) fs.rmSync(target, { recursive: true, force: true });
            else if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
          } catch {
            // 清理失败不影响结论，下一次会因为目录非空而如实报告
          }
          const detail = cloned.stderr || 'git clone 失败';
          lastCloneAttempt = { ok: false, at: new Date().toISOString(), target, remote, detail };
          logger.warn(`知识库自动克隆失败：${detail}`);
          return { attempted: true, ...lastCloneAttempt };
        }
        const problem = checkoutProblem(target);
        lastCloneAttempt = problem
          ? { ok: false, at: new Date().toISOString(), target, remote, detail: `克隆完成但校验失败：${problem}` }
          : { ok: true, at: new Date().toISOString(), target, remote, detail: `已克隆到 ${target}` };
        if (!problem) logger.info(`知识库自动克隆完成：${target}`);
        return { attempted: true, ...lastCloneAttempt };
      } finally {
        clonePromise = null;
      }
    })();

    return clonePromise;
  },

  /**
   * 刷新 checkout：只做 fetch，并且只有在 main 分支且工作树干净时才快进。
   * 不切分支、不动本地改动 —— 那是用户的 checkout，不是 Sakura 的缓存。
   */
  async refreshCheckout(dir) {
    const fetched = await runGit(['fetch', 'origin'], dir, 5 * 60 * 1000);
    if (!fetched.ok) {
      return { ok: false, fastForwarded: false, detail: fetched.stderr || 'git fetch 失败' };
    }
    const head = await readHead(dir);
    if (head.branch !== 'main' || head.clean !== true) {
      return {
        ok: true,
        fastForwarded: false,
        detail: `已 fetch，但工作树不在干净的 main 上（分支 ${head.branch ?? '未知'}${
          head.clean === false ? '，有未提交改动' : ''
        }），不改动你的 checkout。`,
      };
    }
    const merged = await runGit(['merge', '--ff-only', 'origin/main'], dir, 2 * 60 * 1000);
    return merged.ok
      ? { ok: true, fastForwarded: true, detail: merged.stdout || '已快进到 origin/main' }
      : { ok: true, fastForwarded: false, detail: merged.stderr || '无法快进，保留当前 checkout' };
  },

  /** 本轮冻结的知识库快照：报告与署名读它，不读之后变动的全局配置。 */
  snapshot(status) {
    if (!status?.available) {
      return { active: false, skill: RESOLVER_SKILL_NAME, detail: status?.detail ?? null };
    }
    return {
      active: true,
      skill: RESOLVER_SKILL_NAME,
      pluginPath: status.plugin.path,
      wikiPath: status.wiki.path,
      commit: status.wiki.head?.commit ?? null,
      branch: status.wiki.head?.branch ?? null,
      committedAt: status.wiki.head?.committedAt ?? null,
      capturedAt: new Date().toISOString(),
    };
  },

  /**
   * 引用核对：AI 声称引用的 wiki 页面必须在 checkout 里真实存在。
   * 只允许 checkout 内部的相对路径，符号链接与越级路径一律拒绝。
   */
  hasFile(wikiPath, relativePath) {
    const root = String(wikiPath ?? '').trim();
    const normalized = normalizeWikiPath(relativePath);
    if (!root || !normalized) return false;
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, normalized);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (!target.startsWith(prefix)) return false;
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  },

  invalidate() {
    cache = null;
  },

  /** 用户显式点刷新时清掉失败冷却，让这一次立刻重试克隆。 */
  resetProvisionCooldown() {
    lastCloneAttempt = null;
  },
};

export function logKnowledgeBaseState(status) {
  if (status.available) logger.info(`知识库可用：${status.wiki.path}`);
  else logger.warn(`知识库不可用：${status.detail}`);
}
