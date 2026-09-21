import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bATATT[A-Za-z0-9_\-=]{10,}/g,
  /\bBBDC-[A-Za-z0-9_\-=]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._\-=]{8,}/gi,
  /\b[A-Za-z0-9._%+-]+:[^\s@/]{8,}@/g,
];

const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|apikey|api_key|cookie)/i;

/** 日志脱敏：Token 不进入日志、文档、AI 提示与导出（FR-01 / AC15）。 */
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, seen);
    }
    return out;
  }
  return value;
}

let stream = null;
function getStream() {
  if (stream) return stream;
  fs.mkdirSync(paths.logs, { recursive: true });
  const file = path.join(paths.logs, `sakura-${new Date().toISOString().slice(0, 10)}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
  return stream;
}

function write(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: redact(String(message)),
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  getStream().write(`${line}\n`);
  if (level === 'error') console.error(entry.message);
  else if (level !== 'debug') console.log(`[${level}] ${entry.message}`);
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
