/**
 * AI 署名与人工发布身份（FR-10 / AC19-AC22）。
 *
 * - 署名由应用根据本轮不可变元数据确定性拼装，不依赖模型自行追加。
 * - 正文与署名分开存储；重复打开预览或重试发布不会累加署名。
 * - 只有署名、没有实质正文时不构成可发布内容。
 */

export const SIGNATURE_SEPARATOR = '---';

export const SignatureContext = {
  /** 报告内草稿：只能显示待人工确认，不能声称已审核或已发布。 */
  DRAFT: 'draft',
  /** 发布预览与实际发送：使用确认发布时的真实账号信息。 */
  PUBLISH: 'publish',
};

const DEMO_LINE = 'Demo run: generated in Sakura mock mode, not published to any remote system.';

/**
 * @param {object} round 轮次快照（含不可变的 model 信息）
 * @param {object} options { context, publisherName, demo }
 */
export function buildEnglishSignature(round, options) {
  const { context = SignatureContext.DRAFT, publisherName, demo = false } = options ?? {};
  const modelName = round?.model?.name;
  if (!modelName) {
    throw new Error('无法确认本轮模型，禁止生成署名与发布内容');
  }

  const lines = [`AI-assisted review by Sakura using GitHub Copilot (${modelName}).`];
  if (context === SignatureContext.PUBLISH) {
    if (!publisherName) throw new Error('无法确认人工发布者，禁止生成发布署名');
    lines.push(`Human-reviewed and published by ${publisherName}.`);
  } else {
    lines.push('Pending human confirmation. Not published.');
  }
  if (demo) lines.push(DEMO_LINE);

  return `${SIGNATURE_SEPARATOR}\n${lines.join('\n')}`;
}

/** 中文报告署名（FR-10）：与轮次、代码版本相邻展示。 */
export function buildChineseAttribution(round, pullRequest, options = {}) {
  const modelName = round?.model?.name;
  if (!modelName) throw new Error('无法确认本轮模型，禁止生成署名');
  return {
    text: `AI 生成来源：Sakura / GitHub Copilot / ${modelName}`,
    context: [
      `PR #${pullRequest.number}`,
      `第 ${round.roundNumber} 轮`,
      `源 ${short(round.sourceCommit)} → 目标 ${short(round.targetCommit)}`,
    ].join(' · '),
    humanState: options.publisherName
      ? `已由 ${options.publisherName} 人工审核并发布`
      : '待人工确认（尚未发布）',
    demo: Boolean(options.demo),
  };
}

const short = (commit) => (commit ? String(commit).slice(0, 12) : '未知');

const SIGNATURE_BLOCK = new RegExp(
  `\\n*${SIGNATURE_SEPARATOR}\\n(?:AI-assisted review by Sakura[\\s\\S]*)$`,
);

/** 去掉任何既有署名块，保证正文只存正文（幂等，AC20）。 */
export function stripSignature(body) {
  if (!body) return '';
  return body.replace(SIGNATURE_BLOCK, '').trimEnd();
}

/** 组装最终正文：先完整正文，再附加一次署名（FR-10）。 */
export function composeBody(body, signature) {
  const clean = stripSignature(body ?? '').trim();
  return `${clean}\n\n${signature}`;
}

/** 署名本身不算有效正文，不向远端写入署名空壳（AC22）。 */
export function hasSubstantiveBody(body) {
  return stripSignature(body ?? '').trim().length > 0;
}
