/**
 * EI 工程 wiki 知识库（FR-12）。
 *
 * PR 评审必须以 `ei-ai-skills` 插件里的 `ei-llm-wiki` skill 作为知识库入口：
 * 子系统怎么工作、某个决定为什么这么定、历史缺陷留下过什么教训，都在 wiki 里，
 * 只看 diff 得不出这些结论。
 *
 * 本文件只放纯函数（解析与校验），所有落盘与 git 操作在 knowledgeBaseService 中完成，
 * 便于单测覆盖「引用是否真实存在」这条硬校验。
 */

/** 一个合法的 ei-llm-wiki checkout 必须同时具备这三个文件（与 skill 定义一致）。 */
export const WIKI_MARKER_FILES = ['CLAUDE.md', 'index.md', '_meta/lint.py'];

/** 插件内 skill 的目录名；canonical skill 清单位于 checkout 的 .claude/skills 下。 */
export const RESOLVER_SKILL_NAME = 'ei-llm-wiki';
export const CANONICAL_SKILL_GLOB_DIR = '.claude/skills';

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * 只取 name / description 两个字段，且只支持该文件既有的写法；
 * 解析不出 name 时返回 null，不臆造一个技能名。
 */
export function parseSkillFrontmatter(text) {
  const content = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;

  const fields = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const keyed = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine);
    if (keyed) {
      currentKey = keyed[1];
      fields[currentKey] = unquote(keyed[2]);
      continue;
    }
    // 折行的续写（前面有缩进）并入上一个字段，避免长 description 被截断。
    if (currentKey && /^\s+\S/.test(rawLine)) {
      fields[currentKey] = `${fields[currentKey]} ${rawLine.trim()}`.trim();
    }
  }

  if (!fields.name) return null;
  return { name: fields.name, description: fields.description ?? '' };
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * 归一化 AI 给出的 wiki 引用路径：统一分隔符、去掉前导 ./ 与 /。
 * 绝对路径、越级路径直接判为非法：引用必须落在 checkout 内部。
 */
export function normalizeWikiPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('/')) return null;
  const cleaned = raw.replace(/^\.\//, '').split('#')[0].trim();
  if (!cleaned || cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/**
 * 校验本轮是否真的把 wiki 当知识库用了（FR-12 / AC26）。
 *
 * 严格保护：引用的页面必须在 checkout 里真实存在（由 hasFile 回调核对），
 * 编造的路径一律判为不通过 —— 否则「查过 wiki」会退化成一句无法核实的自述。
 * 检索后确实没有相关页面是允许的，但必须说明检索过什么、为什么没命中。
 *
 * @param {object} raw AI 返回的 wikiConsulted 段
 * @param {{ hasFile: (path: string) => boolean }} options
 */
export function validateWikiUsage(raw, { hasFile } = {}) {
  const problems = [];
  const push = (code, message) => problems.push({ code, message });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [
        {
          code: 'wiki_consulted_missing',
          message: '结果中缺少 wikiConsulted：本轮要求以 ei-llm-wiki 作为知识库，必须说明检索情况',
        },
      ],
      references: [],
    };
  }

  if (raw.queried !== true) {
    push('wiki_not_consulted', '本轮没有检索 ei-llm-wiki 知识库，评审结论不完整');
  }

  const queries = Array.isArray(raw.queries) ? raw.queries.filter((item) => String(item ?? '').trim()) : [];
  if (!queries.length) {
    push('wiki_queries_missing', '缺少 wiki 检索关键词，无法核对知识库是否被真正使用');
  }

  const references = [];
  const rawRefs = Array.isArray(raw.references) ? raw.references : [];
  if (!Array.isArray(raw.references)) {
    push('wiki_references_invalid', 'wikiConsulted.references 必须是数组');
  }

  rawRefs.forEach((ref, index) => {
    const label = `#${index + 1}`;
    const path = normalizeWikiPath(ref?.path);
    if (!path) {
      push('wiki_reference_path_invalid', `wiki 引用 ${label} 的路径非法或越出 checkout：${ref?.path ?? '(空)'}`);
      return;
    }
    if (typeof hasFile === 'function' && !hasFile(path)) {
      // 路径不存在只有一个解释：引用是编出来的。不能让它混进报告。
      push('wiki_reference_missing', `wiki 引用 ${label} 在 checkout 中不存在：${path}`);
      return;
    }
    references.push({
      path,
      titleZh: String(ref?.titleZh ?? '').trim() || path,
      noteZh: String(ref?.noteZh ?? '').trim(),
    });
  });

  if (!references.length && !String(raw.noteZh ?? '').trim()) {
    push('wiki_no_reference_note_missing', '没有引用任何 wiki 页面时，必须说明检索过程与未命中的原因');
  }

  return { ok: problems.length === 0, problems, references };
}

/** 校验单条发现引用的 wiki 页面；引用是可选的，但写了就必须真实存在。 */
export function validateFindingWikiRefs(refs, { hasFile } = {}) {
  if (refs === undefined || refs === null) return { ok: true, problems: [], refs: [] };
  if (!Array.isArray(refs)) {
    return {
      ok: false,
      problems: [{ code: 'finding_wiki_refs_invalid', message: 'wikiRefs 必须是数组' }],
      refs: [],
    };
  }
  const problems = [];
  const normalized = [];
  for (const item of refs) {
    const path = normalizeWikiPath(typeof item === 'string' ? item : item?.path);
    if (!path) {
      problems.push({ code: 'finding_wiki_ref_invalid', message: `wiki 引用路径非法：${item}` });
      continue;
    }
    if (typeof hasFile === 'function' && !hasFile(path)) {
      problems.push({ code: 'finding_wiki_ref_missing', message: `wiki 引用在 checkout 中不存在：${path}` });
      continue;
    }
    normalized.push(path);
  }
  return { ok: problems.length === 0, problems, refs: normalized };
}

/** 知识库摘要文本，用于报告署名旁展示本轮实际使用的 wiki 版本。 */
export function describeKnowledgeSnapshot(snapshot) {
  if (!snapshot?.active) return null;
  const commit = snapshot.commit ? String(snapshot.commit).slice(0, 12) : '未知版本';
  return `知识库：ei-llm-wiki@${commit}（${RESOLVER_SKILL_NAME} skill）`;
}
