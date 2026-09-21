import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { settingsService, SettingKey } from './settingsService.js';
import { credentialStore } from '../security/credentialStore.js';
import { CredentialName } from '../integrations/registry.js';
import { AppError, ErrorKind, validationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * 独立只读 Git 缓存（D06 / FR-05 / AC14）。
 *
 * - 只在 data/repo-cache 下操作裸仓库，绝不初始化或修改用户的开发目录；
 * - remote 地址不含 Token，凭据通过 askpass 辅助脚本从环境变量读取（AC15）；
 * - 只执行 fetch / cat-file / show 等只读命令，不写回远端，不切分支。
 */

const ASKPASS_NAME = process.platform === 'win32' ? 'sakura-askpass.cmd' : 'sakura-askpass.sh';
// Bitbucket 的 HTTPS 会先问用户名再问密码，两个提示都走同一个 askpass，
// 因此按提示词区分：用户名给账号标识，密码才是 Token（AC15，Token 不进命令行）。
const ASKPASS_BODY =
  process.platform === 'win32'
    ? [
        '@echo off',
        'echo %~1| findstr /I "username" >nul',
        'if errorlevel 1 (echo(%SAKURA_GIT_PASSWORD%) else (echo(%SAKURA_GIT_USERNAME%)',
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'case "$1" in',
        '  *[Uu]sername*) printf "%s\\n" "$SAKURA_GIT_USERNAME" ;;',
        '  *) printf "%s\\n" "$SAKURA_GIT_PASSWORD" ;;',
        'esac',
        '',
      ].join('\n');

const slug = (repository) => String(repository).replace(/[^a-zA-Z0-9._-]+/g, '_');

function cacheDirFor(repository) {
  return path.join(paths.repoCache, `${slug(repository)}.git`);
}

function ensureAskpass() {
  fs.mkdirSync(paths.repoCache, { recursive: true });
  const file = path.join(paths.repoCache, ASKPASS_NAME);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current !== ASKPASS_BODY) {
    fs.writeFileSync(file, ASKPASS_BODY, { mode: 0o700 });
  }
  return file;
}

/**
 * 清掉父进程注入的 Git 配置注入变量。
 *
 * 某些宿主（如 Copilot CLI 的终端）会注入 `GIT_CONFIG_COUNT` / `GIT_CONFIG_PARAMETERS`，
 * 其中包含 `credential.interactive=never`、`safe.bareRepository=explicit` 等设置，
 * 会让本进程的 askpass 直接失效（报 `unable to get password from user`）。
 * 缓存仓库完全由本程序管理，所以这里只清理自己进程的环境，不改动用户配置。
 */
function baseGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  delete env.GIT_EXEC_PATH;
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_ADVICE = '0';
  return env;
}

function runGit(args, { cwd, token, username, external = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const env = baseGitEnv();
    const config = ['-c', 'safe.bareRepository=all'];
    if (external) {
      // 对用户自己的仓库只做最克制的读取：不碰 index 锁，不触发 LFS 等 filter，
      // 确保不会在对方工作区留下任何痕迹。
      config.unshift('--no-optional-locks');
      config.push(
        '-c',
        'filter.lfs.smudge=cat',
        '-c',
        'filter.lfs.process=',
        '-c',
        'filter.lfs.required=false',
        '-c',
        'core.fsmonitor=false',
      );
    }
    if (token) {
      env.GIT_ASKPASS = ensureAskpass();
      env.SAKURA_GIT_PASSWORD = token;
      env.SAKURA_GIT_USERNAME = username || 'x-token-auth';
      // 只允许 askpass 这一条取凭据的途径：不落盘、不弹窗、不读用户的凭据管理器。
      config.push('-c', 'credential.interactive=true', '-c', 'credential.helper=');
    }
    const child = spawn('git', [...config, ...args], {
      cwd,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr: timedOut ? 'git 命令超时' : stderr,
      });
    });
  });
}

const cleanMessage = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ');

export const gitCacheService = {
  settings() {
    return settingsService.get(SettingKey.GIT_CACHE) ?? {};
  },

  remoteUrl(repository) {
    const template = this.settings().remoteUrlTemplate ?? '';
    if (!template.includes('{repository}')) {
      throw validationError('Git 缓存远端地址模板必须包含 {repository} 占位符');
    }
    if (/@|:\/\/[^/]*:[^/]*@/.test(template)) {
      throw validationError('远端地址不得包含内嵌凭据；Token 只通过受保护存储传递');
    }
    return template.replace('{repository}', repository);
  },

  async available() {
    const result = await runGit(['--version'], { timeoutMs: 10_000 });
    return result.ok
      ? { ok: true, version: result.stdout.trim() }
      : { ok: false, detail: cleanMessage(result.stderr) || '本机未安装可用的 git' };
  },

  /** 供界面展示的缓存概况；不做任何网络访问。 */
  status() {
    const settings = this.settings();
    const repository = settingsService.repository();
    const dir = cacheDirFor(repository);
    let sizeBytes = 0;
    let exists = false;
    if (fs.existsSync(dir)) {
      exists = true;
      const walk = (target) => {
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          const full = path.join(target, entry.name);
          if (entry.isDirectory()) walk(full);
          else sizeBytes += fs.statSync(full).size;
        }
      };
      walk(dir);
    }
    return {
      enabled: settings.enabled !== false,
      mode: settingsService.integrationMode(),
      repository,
      directory: dir,
      exists,
      sizeBytes,
      remoteUrl: settings.remoteUrlTemplate?.replace('{repository}', repository) ?? '',
      isolatedFromWorkspace: true,
      settings,
      localSource: this.localSource(),
    };
  },

  /**
   * 本机已有克隆作为只读上下文来源。
   * 这里只校验路径可用，绝不写入：后续也只执行 cat-file / show。
   */
  localSource() {
    const configured = String(this.settings().localSourcePath ?? '').trim();
    if (!configured) return { configured: false, path: null, ok: false, detail: '未配置本地仓库路径' };
    if (!fs.existsSync(configured)) {
      return { configured: true, path: configured, ok: false, detail: '路径不存在' };
    }
    const isRepo =
      fs.existsSync(path.join(configured, '.git')) || fs.existsSync(path.join(configured, 'HEAD'));
    if (!isRepo) {
      return { configured: true, path: configured, ok: false, detail: '该目录不是 Git 仓库' };
    }
    return { configured: true, path: configured, ok: true, detail: null, readOnly: true };
  },

  /** 判断某个目录里是否已有全部目标提交；短哈希也能解析。 */
  async hasCommits(dir, commits, { external = false } = {}) {
    for (const commit of commits) {
      const found = await runGit(['cat-file', '-e', `${commit}^{commit}`], { cwd: dir, external });
      if (!found.ok) return { ok: false, missing: commit };
    }
    return { ok: true, missing: null };
  },

  /**
   * Bitbucket PR API 返回的是 12 位短哈希，而 `git fetch <url> <sha>` 必须用完整 40 位，
   * 否则永远是 `couldn't find remote ref`。因此远端一律按分支 ref 拉取。
   */
  async fetchBranches({ dir, url, branches, token, username }) {
    const refs = [...new Set((branches ?? []).filter(Boolean))];
    if (!refs.length) return { ok: false, detail: '没有可用于拉取的分支名' };
    const specs = refs.map((branch) => `+refs/heads/${branch}:refs/sakura/${branch}`);
    const result = await runGit(
      ['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', url, ...specs],
      { cwd: dir, token, username, timeoutMs: 20 * 60 * 1000 },
    );
    return result.ok ? { ok: true } : { ok: false, detail: cleanMessage(result.stderr) || '拉取失败' };
  },

  /**
   * 确保本轮要评审的 commit 可以只读访问。
   * 优先使用本机已有克隆（零拷贝、不碰工作区），不可用时回退到独立网络缓存。
   * 演示模式与未启用时明确返回不可用原因，不假装已拉取真实代码。
   */
  async ensureCommits({ repository, commits, branches = [] }) {
    const settings = this.settings();
    if (settings.enabled === false) {
      return { available: false, reason: 'Git 缓存已在设置中关闭' };
    }
    if (settingsService.integrationMode() !== 'live') {
      return { available: false, reason: '演示模式不拉取真实仓库，上下文仅来自演示 diff' };
    }
    const wanted = [...new Set((commits ?? []).filter(Boolean))];
    if (!wanted.length) return { available: false, reason: '本轮没有可拉取的提交版本' };

    const git = await this.available();
    if (!git.ok) return { available: false, reason: git.detail };

    const reasons = [];

    // 1) 本机已有克隆：只读命中就直接用，不做任何网络访问，也不修改该仓库。
    const local = this.localSource();
    if (local.ok) {
      const probe = await this.hasCommits(local.path, wanted, { external: true });
      if (probe.ok) {
        return {
          available: true,
          source: 'local',
          directory: local.path,
          commits: wanted,
          fetched: [],
          readOnly: true,
          external: true,
        };
      }
      reasons.push(`本地仓库缺少提交 ${probe.missing}`);
    } else if (local.configured) {
      reasons.push(`本地仓库不可用：${local.detail}`);
    }

    // 2) 独立网络缓存：按分支 ref 拉取，避免短哈希导致的 couldn't find remote ref。
    const dir = cacheDirFor(repository);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const init = await runGit(['init', '--bare', '--quiet'], { cwd: dir });
      if (!init.ok) {
        return { available: false, reason: [...reasons, cleanMessage(init.stderr)].join('；') };
      }
    }

    const cached = await this.hasCommits(dir, wanted);
    if (cached.ok) {
      return {
        available: true,
        source: 'cache',
        directory: dir,
        commits: wanted,
        fetched: [],
        readOnly: true,
      };
    }

    const token = await credentialStore.get(CredentialName.BITBUCKET);
    // Atlassian API Token 走 HTTPS 时用户名必须是账号邮箱；仓库访问令牌则用 x-token-auth。
    const username = settingsService.get(SettingKey.BITBUCKET)?.email || 'x-token-auth';
    const url = this.remoteUrl(repository);
    const fetched = await this.fetchBranches({ dir, url, branches, token, username });
    if (!fetched.ok) {
      const reason = [...reasons, fetched.detail].filter(Boolean).join('；');
      logger.warn('Git 缓存拉取失败', { repository, detail: reason });
      return { available: false, reason, directory: dir };
    }

    const after = await this.hasCommits(dir, wanted);
    if (!after.ok) {
      const reason = [...reasons, `拉取分支后仍缺少提交 ${after.missing}`].join('；');
      logger.warn('Git 缓存拉取后仍缺少提交', { repository, detail: reason });
      return { available: false, reason, directory: dir };
    }

    return {
      available: true,
      source: 'remote',
      directory: dir,
      commits: wanted,
      fetched: branches,
      readOnly: true,
    };
  },

  /** 只读读取某个版本下的文件内容，用于范围外上下文（FR-03）。 */
  async readFile({ repository, commit, filePath, directory, external, maxBytes = 120_000 }) {
    const dir = directory ?? cacheDirFor(repository);
    if (!fs.existsSync(dir)) {
      throw new AppError(ErrorKind.PRECONDITION, '本地 Git 缓存尚未建立');
    }
    const isExternal = external ?? dir === this.localSource().path;
    const result = await runGit(['show', `${commit}:${filePath}`], { cwd: dir, external: isExternal });
    if (!result.ok) {
      throw new AppError(ErrorKind.NOT_FOUND, `缓存中没有 ${filePath}@${commit}`, {
        details: { detail: cleanMessage(result.stderr) },
      });
    }
    const truncated = result.stdout.length > maxBytes;
    return {
      filePath,
      commit,
      truncated,
      content: truncated ? result.stdout.slice(0, maxBytes) : result.stdout,
    };
  },

  /** 清理前先给出影响预览，不擅自删除用户数据（第 7 章）。 */
  clear({ confirm = false } = {}) {
    const status = this.status();
    if (!confirm) return { removed: false, preview: status };
    if (status.exists) fs.rmSync(status.directory, { recursive: true, force: true });
    return { removed: status.exists, preview: { ...status, exists: false, sizeBytes: 0 } };
  },
};
