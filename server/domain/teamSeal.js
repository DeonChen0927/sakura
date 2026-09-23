/**
 * Team Seal 评审范围识别（FR-03 / AC02）。
 *
 * 真实来源是 Bitbucket Codeowner Bot 发在 PR 里的评论（不是 PR 描述），格式形如：
 *
 *   A review from team **Seal** (@{uuid}, @{uuid}) is required due to changes in:
 *
 *   * `/path/to/dir/`
 *   * `/path/to/other/`
 *
 * 同一条评论里可能包含多个团队的区块（Seal、Meerkat…），只取 Seal 的那一段。
 *
 * 原则：
 * - 有明确标记时只评审标记覆盖的范围，不猜测字符串前缀。
 * - 区分「文件 / 目录 / 通配符 / 模块名」四类条目，按各自规则精确匹配 diff 文件。
 * - 标记缺失或条目全部落空时不再阻断，而是回退为「评审本 PR 的全部变更」，
 *   并以警告如实说明这不是 Team Seal 范围（产品决定：宁可多评，不要评不了）。
 */

export const SCOPE_TEAM = 'Seal';
export const SCOPE_MARKER = `A review from team ${SCOPE_TEAM} is required due to changes in:`;

// 团队名可能带 Markdown 粗体，后面还跟着一串评审人 mention，因此用正则而不是整串比对。
const MARKER_RE =
  /A\s+review\s+from\s+team\s+\*{0,2}([A-Za-z0-9 _-]+?)\*{0,2}\s*(?:\([^)]*\))?\s*is\s+required\s+due\s+to\s+changes\s+in\s*[:：]/i;
// 团队区块的结束标志：分隔线、机器人的结论行，或下一段团队标记。
const BLOCK_END = /^\s*(?:~~+|-{3,}|\*{3,}|:[a-z_]+:|Info\s*[:：])/i;

export const EntryKind = {
  FILE: 'file',
  DIRECTORY: 'directory',
  GLOB: 'glob',
  MODULE: 'module',
};

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const HEADING = /^\s*#{1,6}\s/;
const CODE_FENCE = /^\s*```/;
const INLINE_CODE = /`([^`]+)`/g;

const stripDecoration = (value) =>
  value
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^`(.+)`$/, '$1')
    .replace(/[,;。，；]+$/, '')
    .trim();

/** 从一段文本中定位 Team Seal 标记块并抽取条目原文，保留原始行号便于展示识别依据。 */
export function extractScopeBlock(text) {
  if (!text || typeof text !== 'string') {
    return { found: false, markerLine: null, rawEntries: [] };
  }
  const lines = text.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => {
    const match = MARKER_RE.exec(line);
    return match && match[1].trim().toLowerCase() === SCOPE_TEAM.toLowerCase();
  });
  if (markerIndex === -1) return { found: false, markerLine: null, rawEntries: [] };

  const rawEntries = [];
  const tail = lines[markerIndex].split(MARKER_RE).pop() ?? '';
  const inlineOnSameLine = tail.trim();
  if (inlineOnSameLine) {
    for (const part of inlineOnSameLine.split(/[,;，；]/)) {
      const value = stripDecoration(part);
      if (value) rawEntries.push({ raw: value, line: markerIndex + 1 });
    }
  }

  let inFence = false;
  for (let i = markerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const value = stripDecoration(line);
      if (value) rawEntries.push({ raw: value, line: i + 1 });
      continue;
    }
    if (!line.trim()) {
      if (rawEntries.length) break;
      continue;
    }
    // 机器人评论里同一条会串接多个团队的区块，必须在分隔线/结论行处停下，
    // 否则会把别的团队的范围也算成 Seal 的。
    if (BLOCK_END.test(line) || MARKER_RE.test(line)) break;
    if (HEADING.test(line)) break;
    const match = LIST_ITEM.exec(line);
    if (match) {
      const value = stripDecoration(match[1]);
      if (value) rawEntries.push({ raw: value, line: i + 1 });
      continue;
    }
    // 非列表行：只有当它整体是行内代码时才认定为条目，其余视为块结束。
    const codes = [...line.matchAll(INLINE_CODE)].map((m) => m[1].trim());
    if (codes.length && line.replace(INLINE_CODE, '').trim() === '') {
      codes.forEach((value) => rawEntries.push({ raw: value, line: i + 1 }));
      continue;
    }
    break;
  }

  return { found: true, markerLine: markerIndex + 1, rawEntries };
}

/** 条目规范化：仅做大小写无关的空白与分隔符清理，不做任何前缀推测。 */
export function normalizeEntry(raw) {
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    // 机器人写的是仓库根绝对路径（/a/b/），diff 里是相对路径，去掉前导斜杠才能对上。
    .replace(/^\/+/, '');
  const value = cleaned.replace(/\s+/g, ' ');
  if (value.includes('*') || value.includes('?')) {
    return { value, kind: EntryKind.GLOB };
  }
  if (value.endsWith('/')) {
    return { value: value.replace(/\/+$/, ''), kind: EntryKind.DIRECTORY };
  }
  if (value.includes('/')) {
    const last = value.slice(value.lastIndexOf('/') + 1);
    return { value, kind: last.includes('.') ? EntryKind.FILE : EntryKind.DIRECTORY };
  }
  if (value.includes('.') && !value.includes(' ')) {
    return { value, kind: EntryKind.FILE };
  }
  return { value, kind: EntryKind.MODULE };
}

function globToRegex(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

const pathsOf = (file) => [file.path, file.oldPath].filter(Boolean);

function matchEntry(entry, files) {
  const lower = entry.value.toLowerCase();
  const matcher = entry.kind === EntryKind.GLOB ? globToRegex(entry.value) : null;

  return files.filter((file) =>
    pathsOf(file).some((filePath) => {
      const normalized = filePath.replace(/\\/g, '/');
      const candidate = normalized.toLowerCase();
      switch (entry.kind) {
        case EntryKind.FILE:
          return candidate === lower || candidate.endsWith(`/${lower}`);
        case EntryKind.DIRECTORY:
          return candidate === lower || candidate.startsWith(`${lower}/`);
        case EntryKind.GLOB:
          return matcher.test(normalized);
        case EntryKind.MODULE:
          return candidate.split('/').includes(lower);
        default:
          return false;
      }
    }),
  );
}

/** 范围识别失败时的回退：评审本 PR 的全部变更，并标明不是 Team Seal 范围。 */
export const ScopeFallback = { ALL_CHANGES: 'all_changes' };

/**
 * 按作者身份直接整份评审的策略（不是回退，是规则）：
 * - author_is_me：我自己发起的 PR，需要整份自查
 * - author_in_team：Team Seal 成员发起的 PR，本团队对自己的改动负全责
 * 两者都不看 Codeowner Bot 的 Seal 范围标记 —— 那个标记是给「外部改动」划范围的。
 */
export const ScopePolicy = {
  TEAM_SCOPE: 'team_scope',
  AUTHOR_IS_ME: 'author_is_me',
  AUTHOR_IN_TEAM: 'author_in_team',
};

function fallbackScope({ markerLine = null, origin = null, entries = [], changedFiles, warnings }) {
  const allPaths = changedFiles.map((file) => file.path).sort();
  return {
    ok: true,
    policy: ScopePolicy.TEAM_SCOPE,
    fallback: ScopeFallback.ALL_CHANGES,
    marker: SCOPE_MARKER,
    markerLine,
    origin,
    entries,
    inScopeFiles: allPaths,
    outOfScopeFiles: [],
    warnings,
    blockers: [],
  };
}

/**
 * 作者归属决定的整份评审范围。与 fallbackScope 形状一致，但 fallback 为 null：
 * 这不是「没找到标记只好全评」，而是规则本就要求全评，两者在报告与提示词里必须分得开。
 */
export function resolveFullChangeScope(changedFiles = [], { policy, reason, warnings = [] } = {}) {
  return {
    ok: true,
    policy,
    reason,
    fallback: null,
    marker: SCOPE_MARKER,
    markerLine: null,
    origin: null,
    entries: [],
    inScopeFiles: changedFiles.map((file) => file.path).sort(),
    outOfScopeFiles: [],
    warnings,
    blockers: [],
  };
}

/**
 * @param {string|Array<{text:string, origin?:string}>} sources PR 描述，或「描述 + 评论」多来源
 * @param {Array<{path:string, oldPath?:string, status?:string}>} changedFiles diff 文件列表
 */
export function resolveTeamSealScope(sources, changedFiles = []) {
  const list = (Array.isArray(sources) ? sources : [{ text: sources, origin: 'description' }]).filter(
    (item) => item && typeof item.text === 'string' && item.text.trim(),
  );

  let block = { found: false, markerLine: null, rawEntries: [] };
  let origin = null;
  for (const item of list) {
    const candidate = extractScopeBlock(item.text);
    if (candidate.found) {
      block = candidate;
      origin = item.origin ?? null;
      break;
    }
  }
  const warnings = [];

  if (!block.found) {
    warnings.push({
      code: 'scope_marker_missing',
      message: `PR 描述与评论中都没有 Team Seal 范围标记：“${SCOPE_MARKER}”，本轮改为评审全部代码改动。`,
      remedy:
        '该标记通常由 Bitbucket Codeowner Bot 自动发表在 PR 评论中；若需要按 Team Seal 范围评审，请补充标记及范围条目后重新同步。',
    });
    return fallbackScope({ changedFiles, warnings });
  }

  if (!block.rawEntries.length) {
    warnings.push({
      code: 'scope_entries_missing',
      message: '找到 Team Seal 标记，但其后没有可识别的范围条目，本轮改为评审全部代码改动。',
      remedy: '请在标记下方用列表形式列出范围条目（文件、目录、通配符或模块名）。',
    });
    return fallbackScope({ markerLine: block.markerLine, origin, changedFiles, warnings });
  }

  const seen = new Set();
  const entries = [];
  for (const rawEntry of block.rawEntries) {
    const normalized = normalizeEntry(rawEntry.raw);
    const dedupeKey = `${normalized.kind}:${normalized.value.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const matchedFiles = matchEntry(normalized, changedFiles);
    const entry = {
      raw: rawEntry.raw,
      line: rawEntry.line,
      normalized: normalized.value,
      kind: normalized.kind,
      matchedFiles: matchedFiles.map((file) => file.path),
      status: matchedFiles.length ? 'matched' : 'unmatched',
    };

    if (!matchedFiles.length) {
      warnings.push({
        code: 'scope_entry_unmatched',
        message: `范围条目「${rawEntry.raw}」没有命中任何本 PR 的变更文件。`,
        remedy: '请修正条目写法，或确认该条目对应的变更是否确实在本 PR 中。',
        entry: entry.normalized,
      });
    }
    entries.push(entry);
  }

  const inScopeFiles = [...new Set(entries.flatMap((entry) => entry.matchedFiles))].sort();

  if (!inScopeFiles.length) {
    warnings.push({
      code: 'scope_no_files',
      message: 'Team Seal 范围没有映射到任何变更文件，本轮改为评审全部代码改动。',
      remedy: '请确认范围条目与实际变更是否一致。',
    });
    return fallbackScope({ markerLine: block.markerLine, origin, entries, changedFiles, warnings });
  }

  const changedPaths = changedFiles.map((file) => file.path);
  const outOfScopeFiles = changedPaths.filter((path) => !inScopeFiles.includes(path)).sort();

  return {
    ok: true,
    policy: ScopePolicy.TEAM_SCOPE,
    fallback: null,
    marker: SCOPE_MARKER,
    markerLine: block.markerLine,
    origin,
    entries,
    inScopeFiles,
    outOfScopeFiles,
    warnings,
    blockers: [],
  };
}

/** 正式发现必须落在范围内变更；范围外内容只能作为只读上下文（FR-03 / AC03）。 */
export function isPathInScope(scope, filePath) {
  if (!scope || !filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return scope.inScopeFiles.some((item) => item.toLowerCase() === normalized.toLowerCase());
}
