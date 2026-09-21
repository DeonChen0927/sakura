import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { paths } from '../config.js';
import { AppError, ErrorKind } from '../lib/errors.js';

const execFileAsync = promisify(execFile);
const STORE_FILE = () => path.join(paths.secrets, 'credentials.json');
const KEY_FILE = () => path.join(paths.secrets, 'fallback.key');
const IS_WINDOWS = process.platform === 'win32';
// 组策略禁用 DPAPI 子进程时的显式降级开关：必须由使用者主动设置，不做静默降级。
const FORCE_FILE_BACKEND = process.env.SAKURA_CREDENTIAL_BACKEND === 'file';
const USE_DPAPI = IS_WINDOWS && !FORCE_FILE_BACKEND;

// 明文与密文通过环境变量传给子进程，避免出现在命令行参数与进程列表中。
const PROTECT_SCRIPT = `
$secure = ConvertTo-SecureString -String $env:SAKURA_SECRET_IO -AsPlainText -Force
[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
`;

const UNPROTECT_SCRIPT = `
$secure = ConvertTo-SecureString -String $env:SAKURA_SECRET_IO.Trim()
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
`;

async function dpapi(script, payload) {
  // 继承自 PowerShell 7 的 PSModulePath 会让 Windows PowerShell 5.1 去加载 7 的
  // Microsoft.PowerShell.Security，类型数据冲突导致模块加载失败；这里剥掉该变量，
  // 让子进程使用自己的默认模块路径。
  const env = { ...process.env, SAKURA_SECRET_IO: payload };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      // 本机默认执行策略可能是 Restricted，那会连内置模块的清单都加载不了；
      // 这里只对本次进程放行，不修改机器策略。
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, env },
    );
    return stdout;
  } catch (cause) {
    throw new AppError(ErrorKind.INTERNAL, '调用 Windows DPAPI 失败，凭据未保存', {
      cause,
      details: { reason: String(cause?.message ?? '').slice(0, 400) },
      remedy:
        '多为组策略限制 PowerShell 所致。可先执行 powershell -NoProfile -ExecutionPolicy Bypass -Command "ConvertTo-SecureString test -AsPlainText -Force | ConvertFrom-SecureString" 确认；' +
        '若确实被策略禁止，可用环境变量 SAKURA_CREDENTIAL_BACKEND=file 启动 Sakura，改用本机密钥文件加密（保护强度低于 DPAPI，请自行评估）。',
    });
  }
}

function fallbackKey() {
  fs.mkdirSync(paths.secrets, { recursive: true });
  const file = KEY_FILE();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(file);
}

async function protect(plaintext) {
  if (USE_DPAPI) {
    const blob = (await dpapi(PROTECT_SCRIPT, plaintext)).trim();
    if (!blob) throw new AppError(ErrorKind.INTERNAL, '凭据保护失败（DPAPI 未返回结果）');
    return { alg: 'dpapi-currentuser', blob };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fallbackKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    alg: 'aes-256-gcm',
    blob: [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.'),
  };
}

async function unprotect(record) {
  if (record.alg === 'dpapi-currentuser') {
    return (await dpapi(UNPROTECT_SCRIPT, record.blob)).replace(/\r?\n$/, '');
  }
  const [iv, tag, data] = record.blob.split('.');
  const decipher = createDecipheriv('aes-256-gcm', fallbackKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function readStore() {
  const file = STORE_FILE();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AppError(ErrorKind.INTERNAL, '凭据存储已损坏，请在连接设置中重新录入');
  }
}

function writeStore(store) {
  fs.mkdirSync(paths.secrets, { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * 凭据只经由专用设置流程写入本地后端，使用 OS 保护存储；
 * 明文不进入数据库、日志、AI 提示或导出（FR-01 / AC15）。
 */
export const credentialStore = {
  async set(name, plaintext) {
    if (!plaintext) throw new AppError(ErrorKind.VALIDATION, '凭据不能为空');
    const store = readStore();
    store[name] = { ...(await protect(plaintext)), updatedAt: new Date().toISOString() };
    writeStore(store);
  },

  async get(name) {
    const record = readStore()[name];
    if (!record) return null;
    return unprotect(record);
  },

  has(name) {
    return Boolean(readStore()[name]);
  },

  status(name) {
    const record = readStore()[name];
    return record ? { present: true, alg: record.alg, updatedAt: record.updatedAt } : { present: false };
  },

  remove(name) {
    const store = readStore();
    delete store[name];
    writeStore(store);
  },
};

export const credentialBackend = USE_DPAPI
  ? 'Windows DPAPI (CurrentUser)'
  : IS_WINDOWS
    ? 'AES-256-GCM 本机密钥文件（已按 SAKURA_CREDENTIAL_BACKEND=file 显式降级）'
    : 'AES-256-GCM 本地密钥文件';
