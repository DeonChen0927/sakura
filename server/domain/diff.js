/**
 * 统一 diff 解析：把 Bitbucket 返回的文本 diff 转成结构化文件/块/行，
 * 用于范围映射、行级评论锚点与前端展示（FR-03 / FR-06）。
 */

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const fileMatch = FILE_HEADER.exec(rawLine);
    if (fileMatch) {
      file = { path: fileMatch[2], oldPath: fileMatch[1], status: 'modified', hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (rawLine.startsWith('new file mode')) file.status = 'added';
    else if (rawLine.startsWith('deleted file mode')) file.status = 'removed';
    else if (rawLine.startsWith('rename from')) file.status = 'renamed';

    const hunkMatch = HUNK_HEADER.exec(rawLine);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = { header: rawLine, oldStart: oldLine, newStart: newLine, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (rawLine.startsWith('+')) {
      hunk.lines.push({ type: 'added', content: rawLine.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      hunk.lines.push({ type: 'removed', content: rawLine.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (rawLine.startsWith(' ')) {
      hunk.lines.push({ type: 'context', content: rawLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files;
}

export function diffStats(files = []) {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const hunk of file.hunks ?? []) {
      for (const line of hunk.lines ?? []) {
        if (line.type === 'added') added += 1;
        else if (line.type === 'removed') removed += 1;
      }
    }
  }
  return { files: files.length, added, removed };
}

/** 只保留范围内文件，用于送往 AI 的 diff 输入（FR-05）。 */
export function filterDiffByPaths(files, paths) {
  const allow = new Set(paths.map((item) => item.toLowerCase()));
  return files.filter((file) => allow.has(String(file.path).toLowerCase()));
}

/** 把结构化 diff 还原为文本，作为 AI 输入的稳定表示。 */
export function renderDiffText(files = []) {
  const out = [];
  for (const file of files) {
    out.push(`diff --git a/${file.oldPath ?? file.path} b/${file.path}`);
    if (file.status === 'added') out.push('new file mode 100644');
    if (file.status === 'removed') out.push('deleted file mode 100644');
    out.push(`--- a/${file.oldPath ?? file.path}`);
    out.push(`+++ b/${file.path}`);
    for (const hunk of file.hunks ?? []) {
      out.push(hunk.header);
      for (const line of hunk.lines ?? []) {
        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        out.push(`${prefix}${line.content}`);
      }
    }
  }
  return out.join('\n');
}
