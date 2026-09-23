import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, ErrorKind } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { buildReviewPrompt } from '../../domain/prompt.js';
import { createLineSplitter, parseEventLine, eventModel, describeEvent } from './jsonl.js';

const execFileAsync = promisify(execFile);

/** 模型不可用时 CLI 的报错特征（实测：`Error: Model "x" from --model flag is not available.`）。 */
const MODEL_REJECTED_RE = /model\s+"[^"]*"[^\n]*not available|unknown model/i;

/** CLI 未认证时的报错特征（实测 1.0.87：退出码 1，stderr 首行即此句）。 */
const AUTH_MISSING_RE = /no authentication information found|not (?:logged in|authenticated)|please (?:run|use) .*\/login/i;

const AUTH_REMEDY =
  '本机 Copilot CLI 没有可用的登录凭据。二选一：①在「连接设置 → Copilot」录入 GitHub Token，' +
  'Sakura 会加密保存并在启动 CLI 时注入；②在终端运行 copilot 后执行 /login 完成登录，再重启 Sakura。';

const authError = (stderr) =>
  new AppError(ErrorKind.PRECONDITION, 'Copilot CLI 未认证，无法调用模型', {
    remedy: AUTH_REMEDY,
    details: { stderr: String(stderr ?? '').trim().slice(0, 300) },
  });

const TOKEN_SOURCE_LABEL = {
  sakura: 'Sakura 加密保存的 Token',
  environment: '启动进程的环境变量',
  cli_login: 'CLI 自身的登录态',
};

/**
 * 归类 CLI 的失败原因。未认证与模型不可用必须分开：混为一谈会让人去反复换模型，
 * 怎么换都失败（实测 1.0.87 未认证时退出码 1，stderr 首行为 No authentication information found）。
 */
export function classifyCliFailure(stderr) {
  const text = String(stderr ?? '');
  if (AUTH_MISSING_RE.test(text)) return 'auth';
  if (MODEL_REJECTED_RE.test(text)) return 'model';
  return null;
}

/** CLI 未提供模型枚举命令（实测 1.0.84：无 models/list-models 子命令）。 */
const MODEL_SOURCE = {
  enumerable: false,
  note:
    '本机 Copilot CLI 未提供列出模型的命令（已实测 1.0.84），因此模型目录由你手工维护；' +
    '每个模型可用“验证”按钮真实调用 CLI 确认是否被接受。',
};

/**
 * 本机 Copilot CLI 适配器。
 *
 * 已验证（CLI 1.0.84）：`--output-format json` 为 JSONL 事件流；`--model` 不可用时
 * 启动即失败；无模型枚举命令。未验证的能力一律以明确错误暴露，不做静默降级，
 * 不自动改用其他模型或 auto。
 */
export function createLiveCopilotClient({
  binary = 'copilot',
  toolPolicy = defaultToolPolicy(),
  timeoutMs = 15 * 60 * 1000,
  probeTimeoutMs = 90 * 1000,
  getModelCatalog = () => [],
  getToken = async () => null,
} = {}) {
  /**
   * CLI 认证来源：优先用 Sakura 加密保管的 Token 注入 COPILOT_GITHUB_TOKEN，
   * 否则沿用启动 Sakura 的进程环境。后者取决于谁启动了服务，不同终端结果不同 ——
   * 这正是「换个终端启动就报未认证」的根因，所以要允许显式注入。
   */
  async function spawnEnv() {
    const token = await getToken().catch(() => null);
    if (!token) return { env: process.env, tokenInjected: false };
    return { env: { ...process.env, COPILOT_GITHUB_TOKEN: token }, tokenInjected: true };
  }

  async function cli(args, options = {}) {
    const { env } = await spawnEnv();
    try {
      return await execFileAsync(binary, args, {
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env,
        ...options,
      });
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        throw new AppError(ErrorKind.PRECONDITION, `未找到 Copilot CLI（${binary}）`, {
          remedy: '请确认本机已安装并登录 Copilot CLI。',
          cause,
        });
      }
      if (classifyCliFailure(cause.stderr) === 'auth') throw authError(cause.stderr);
      throw new AppError(ErrorKind.UPSTREAM, `Copilot CLI 调用失败：${cause.message}`, { cause });
    }
  }

  /**
   * 通用会话探测：启动一次非交互会话，读到会话就绪事件即视为成功并立即终止子进程
   * （在模型调用发起之前，不消耗额外配额）。未认证 / 模型被拒都会走 stderr。
   */
  async function runProbe(extraArgs) {
    const { env, tokenInjected } = await spawnEnv();
    const child = spawn(binary, [...extraArgs, '-p', 'ping', '--output-format', 'json'], {
      windowsHide: true,
      env,
    });

    let accepted = false;
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, probeTimeoutMs);

    const splitter = createLineSplitter((line) => {
      const event = parseEventLine(line);
      if (!event) return;
      if (event.type === 'session.tools_updated' || event.type === 'user.message') {
        accepted = true;
        child.kill('SIGKILL');
      }
    });

    child.stdout.on('data', (chunk) => splitter.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', (error) => {
        reject(
          error.code === 'ENOENT'
            ? new AppError(ErrorKind.PRECONDITION, `未找到 Copilot CLI（${binary}）`, {
                remedy: '请确认本机已安装并登录 Copilot CLI。',
                cause: error,
              })
            : error,
        );
      });
      child.on('close', resolve);
    }).finally(() => clearTimeout(timer));

    splitter.flush();
    return { accepted, stderr, exitCode, timedOut, tokenInjected };
  }

  return {
    mode: 'live',

    modelSource: MODEL_SOURCE,

    async getIdentity() {
      const { stdout } = await cli(['--version']);
      const auth = await this.checkAuth();
      return {
        // --version 在未认证时同样成功，所以登录状态必须单独探测，不能默认 true。
        loggedIn: auth.ok,
        authDetail: auth.detail,
        tokenSource: auth.tokenSource,
        // --version 后面还会跟一行升级提示，只取版本本身。
        version: stdout.trim().split('\n')[0].trim(),
        demo: false,
      };
    },

    /**
     * 真实探测 CLI 是否具备可用凭据：启动一次非交互会话，读到会话就绪事件即认定已认证，
     * 并在模型调用前终止子进程。未认证时 CLI 立即以退出码 1 失败，因此这次探测很快。
     */
    async checkAuth() {
      const model = getModelCatalog().find((entry) => entry.check?.status === 'available');
      const probe = await runProbe(model ? ['--model', model.id] : []);
      const tokenSource = probe.tokenInjected
        ? 'sakura'
        : process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
          ? 'environment'
          : 'cli_login';

      if (probe.accepted) {
        return { ok: true, tokenSource, detail: 'CLI 已接受凭据并创建会话。' };
      }
      if (classifyCliFailure(probe.stderr) === 'auth') {
        return {
          ok: false,
          tokenSource,
          detail: probe.stderr.trim().split('\n')[0].slice(0, 300),
          remedy: AUTH_REMEDY,
        };
      }
      return {
        ok: null,
        tokenSource,
        detail: probe.timedOut
          ? `认证探测超时（${Math.round(probeTimeoutMs / 1000)} 秒）`
          : `认证探测未得到明确结论（退出码 ${probe.exitCode}）：${probe.stderr.trim().slice(0, 200) || '无错误输出'}`,
      };
    },

    /**
     * CLI 不提供模型枚举，因此列表来自用户维护的目录：
     * 返回的 available 只反映上一次真实探测结果，未探测时为 null（不假装可用）。
     */
    async listModels() {
      return getModelCatalog().map((entry) => ({
        id: entry.id,
        name: entry.name ?? entry.id,
        available: entry.check?.status === 'available' ? true : entry.check?.status === 'unavailable' ? false : null,
        checkedAt: entry.check?.checkedAt ?? null,
        detail: entry.check?.detail ?? null,
        demo: false,
      }));
    },

    /**
     * 真实探测模型是否被本机 CLI 接受：启动一次非交互会话，读到会话就绪事件即判定可用
     * 并立即终止子进程（在模型调用发起之前，不消耗额外配额）。
     */
    async verifyModel(modelId) {
      const id = String(modelId ?? '').trim();
      if (!id) throw new AppError(ErrorKind.VALIDATION, '模型 ID 不能为空');

      const { accepted, stderr, exitCode, timedOut } = await runProbe(['--model', id]);

      if (accepted) {
        return { id, status: 'available', detail: 'CLI 已接受该模型并创建会话（探测在模型调用前终止）。' };
      }
      // 未认证不是“模型不可用”：混为一谈会让人去换模型，怎么换都失败。
      if (classifyCliFailure(stderr) === 'auth') throw authError(stderr);
      if (classifyCliFailure(stderr) === 'model') {
        return { id, status: 'unavailable', detail: stderr.trim().split('\n')[0].slice(0, 300) };
      }
      if (timedOut) {
        return { id, status: 'unknown', detail: `探测超时（${Math.round(probeTimeoutMs / 1000)} 秒），未能确认可用性。` };
      }
      return {
        id,
        status: 'unknown',
        detail: `探测未得到明确结论（退出码 ${exitCode}）：${stderr.trim().slice(0, 300) || '无错误输出'}`,
      };
    },

    async testConnection() {
      const identity = await this.getIdentity();
      if (identity.loggedIn === false) throw authError(identity.authDetail);
      return {
        ok: true,
        demo: false,
        detail:
          `已检测到 Copilot CLI ${identity.version}` +
          `，凭据来源：${TOKEN_SOURCE_LABEL[identity.tokenSource] ?? identity.tokenSource}` +
          (identity.loggedIn ? '；' : '（登录状态未确认）；') +
          '模型可用性需在启动评审时实际校验。',
      };
    },

    async runReview({ model, payload, signal, onEvent }) {
      const prompt = buildReviewPrompt(payload);
      // 提示词经 stdin 传入：Windows 单条命令行上限 32767 字符，
      // 带上只读上下文后 --prompt 必然触发 ENAMETOOLONG（已实测）。
      const args = [
        '--model',
        model.id,
        '--output-format',
        'json',
        ...toolPolicy.flatMap((entry) => [entry.flag, entry.value]),
      ];

      onEvent?.({ stage: 'session_created', message: `启动 Copilot CLI（模型 ${model.id}）` });

      const { env } = await spawnEnv();
      const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      child.stdin.on('error', () => {
        // 子进程被取消/超时杀掉时 stdin 会 EPIPE，这里不应压过真正的失败原因
      });
      child.stdin.end(prompt);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let actualModel = null;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });

      const splitter = createLineSplitter((line) => {
        stdout += `${line}\n`;
        const event = parseEventLine(line);
        if (!event) return;
        actualModel = eventModel(event) ?? actualModel;
        const described = describeEvent(event);
        if (described) onEvent?.(described);
      });

      child.stdout.on('data', (chunk) => splitter.push(chunk));
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        onEvent?.({ stage: 'cli_stderr', message: String(chunk).trim().slice(0, 300), level: 'warn' });
      });

      const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      }).finally(() => {
        clearTimeout(timer);
        splitter.flush();
        signal?.removeEventListener('abort', onAbort);
      });

      if (signal?.aborted) throw new AppError(ErrorKind.CONFLICT, '评审已取消，子进程已终止');
      if (timedOut) {
        throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 执行超时，本轮报告不完整', {
          details: { timeoutMs },
        });
      }
      if (exitCode !== 0) {
        logger.warn('Copilot CLI 非零退出', { exitCode, stderr: stderr.slice(0, 1000) });
        if (classifyCliFailure(stderr) === 'auth') throw authError(stderr);
        if (classifyCliFailure(stderr) === 'model') {
          throw new AppError(ErrorKind.PRECONDITION, `所选模型不可用：${model.id}`, {
            remedy: '请在连接设置中重新验证并选择可用模型；系统不会自动改用其他模型。',
            details: { exitCode, stderr: stderr.trim().slice(0, 300) },
          });
        }
        throw new AppError(ErrorKind.UPSTREAM, `Copilot CLI 非零退出（${exitCode}），本轮报告不完整`, {
          details: { exitCode },
        });
      }

      const parsed = parseCliOutput(stdout);
      const modelUsed = parsed.modelUsed ?? actualModel;
      if (modelUsed && modelUsed !== model.id) {
        throw new AppError(ErrorKind.PRECONDITION, '实际使用模型与本轮冻结模型不一致，已阻断', {
          details: { expected: model.id, actual: modelUsed },
        });
      }

      return {
        sessionId: parsed.sessionId,
        modelUsed: modelUsed ?? model.id,
        result: parsed.result,
        exitCode,
        demo: false,
      };
    },
  };
}

/** 最小只读工具集合；提示词不是安全边界，实际隔离依赖 CLI 权限参数。 */
export function defaultToolPolicy() {
  return [
    { flag: '--deny-tool', value: 'shell' },
    { flag: '--deny-tool', value: 'write' },
    { flag: '--allow-tool', value: 'view' },
    { flag: '--allow-tool', value: 'grep' },
    { flag: '--allow-tool', value: 'glob' },
  ];
}

/**
 * CLI 输出解析（JSONL，实测 1.0.84）：
 * 最终回答来自最后一条 assistant.message 的 data.content，会话与退出码来自 result 事件。
 * 截断或格式不符都必须失败，不能转成“通过”（AC06）。
 */
export function parseCliOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 没有输出，本轮报告不完整');

  const events = text
    .split('\n')
    .map((line) => parseEventLine(line.trim()))
    .filter(Boolean);

  if (!events.length) {
    throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 输出不是合法 JSONL（可能被截断）');
  }

  let sessionId = null;
  let modelUsed = null;
  let content = null;
  let legacy = null;

  for (const event of events) {
    if (!event.type) {
      legacy = event;
      continue;
    }
    if (event.type === 'result') {
      sessionId = event.sessionId ?? event.session_id ?? sessionId;
    }
    modelUsed = eventModel(event) ?? modelUsed;
    if (event.type === 'assistant.message' && typeof event.data?.content === 'string') {
      content = event.data.content;
    }
  }

  if (content === null && legacy) {
    sessionId = legacy.session_id ?? legacy.sessionId ?? sessionId;
    modelUsed = legacy.model ?? legacy.model_id ?? modelUsed;
    const payload = legacy.result ?? legacy.response ?? legacy.content ?? legacy;
    return { sessionId, modelUsed, result: typeof payload === 'string' ? extractJson(payload) : payload };
  }

  if (content === null) {
    throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 没有返回最终回答，本轮报告不完整');
  }

  return { sessionId, modelUsed, result: extractJson(content) };
}

/** 从回答文本中取出结构化 JSON（允许包在 ```json 代码块里）。 */
function extractJson(text) {
  const payload = String(text ?? '');
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 结果中没有结构化 JSON');
  }
  try {
    return JSON.parse(payload.slice(start, end + 1));
  } catch {
    throw new AppError(ErrorKind.UPSTREAM, 'Copilot CLI 结果 JSON 解析失败（可能被截断）');
  }
}

