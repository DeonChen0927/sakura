import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillFrontmatter,
  normalizeWikiPath,
  validateWikiUsage,
  validateFindingWikiRefs,
  describeKnowledgeSnapshot,
} from '../server/domain/knowledgeBase.js';
import { buildReviewInvocation, defaultToolPolicy } from '../server/integrations/copilot/live.js';
import { buildReviewPrompt } from '../server/domain/prompt.js';
import { validateAiResult } from '../server/domain/reviewSchema.js';

const SKILL_MD = [
  '---',
  'name: ei-llm-wiki',
  'description: "Resolve or clone the EI engineering wiki checkout,',
  '  then delegate to the matching canonical skill."',
  'compatibility: Requires git CLI',
  '---',
  '',
  '# ei-llm-wiki resolver',
].join('\n');

test('解析 SKILL.md frontmatter，折行的 description 不被截断', () => {
  const manifest = parseSkillFrontmatter(SKILL_MD);
  assert.equal(manifest.name, 'ei-llm-wiki');
  assert.match(manifest.description, /canonical skill/);
});

test('没有 frontmatter 或没有 name 时返回 null，不臆造技能名', () => {
  assert.equal(parseSkillFrontmatter('# 普通 Markdown'), null);
  assert.equal(parseSkillFrontmatter('---\ndescription: x\n---\n'), null);
});

test('越级与绝对路径的 wiki 引用一律拒绝', () => {
  assert.equal(normalizeWikiPath('subsystems/imaging.md'), 'subsystems/imaging.md');
  assert.equal(normalizeWikiPath('.\\subsystems\\imaging.md'), 'subsystems/imaging.md');
  assert.equal(normalizeWikiPath('../secrets.md'), null);
  assert.equal(normalizeWikiPath('/etc/passwd'), null);
  assert.equal(normalizeWikiPath('C:/Windows/system.ini'), null);
});

const hasFile = (path) => ['subsystems/imaging.md', 'defects/2024-cache.md'].includes(path);

test('引用真实存在的 wiki 页面时校验通过', () => {
  const result = validateWikiUsage(
    {
      queried: true,
      queries: ['annotation cache'],
      references: [{ path: 'subsystems/imaging.md', titleZh: '影像子系统', noteZh: '缓存约定' }],
      noteZh: '',
    },
    { hasFile },
  );
  assert.equal(result.ok, true);
  assert.equal(result.references[0].path, 'subsystems/imaging.md');
});

/** 编造引用是最危险的一种「看起来有依据」：必须判不通过。 */
test('引用在 checkout 中不存在时判为编造并阻断', () => {
  const result = validateWikiUsage(
    { queried: true, queries: ['cache'], references: [{ path: 'subsystems/not-there.md' }] },
    { hasFile },
  );
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.code === 'wiki_reference_missing'));
});

test('没有检索知识库时不通过', () => {
  const result = validateWikiUsage({ queried: false, queries: [], references: [] }, { hasFile });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.code === 'wiki_not_consulted'));
});

test('检索后没有命中是允许的，但必须说明原因', () => {
  const withoutNote = validateWikiUsage(
    { queried: true, queries: ['viewport cache'], references: [] },
    { hasFile },
  );
  assert.equal(withoutNote.ok, false);
  assert.ok(withoutNote.problems.some((problem) => problem.code === 'wiki_no_reference_note_missing'));

  const withNote = validateWikiUsage(
    {
      queried: true,
      queries: ['viewport cache'],
      references: [],
      noteZh: '检索 viewport / cache 未命中相关页面',
    },
    { hasFile },
  );
  assert.equal(withNote.ok, true);
});

test('整段 wikiConsulted 缺失时直接判不完整', () => {
  assert.equal(validateWikiUsage(undefined, { hasFile }).ok, false);
});

test('发现级 wikiRefs 可选，但写了就必须真实存在', () => {
  assert.equal(validateFindingWikiRefs(undefined, { hasFile }).ok, true);
  assert.deepEqual(validateFindingWikiRefs(['defects/2024-cache.md'], { hasFile }).refs, [
    'defects/2024-cache.md',
  ]);
  assert.equal(validateFindingWikiRefs(['defects/made-up.md'], { hasFile }).ok, false);
});

test('知识库快照摘要读本轮冻结的版本', () => {
  assert.match(
    describeKnowledgeSnapshot({ active: true, commit: 'abcdef1234567890' }),
    /ei-llm-wiki@abcdef123456/,
  );
  assert.equal(describeKnowledgeSnapshot({ active: false }), null);
});

/** CLI 必须真的挂上插件与 checkout，否则「用 wiki 评审」只是提示词里的一句空话。 */
test('知识库可用时 CLI 挂载插件目录并把工作目录设为 checkout', () => {
  const invocation = buildReviewInvocation({
    model: { id: 'claude-opus-5' },
    knowledgeBase: {
      active: true,
      skill: 'ei-llm-wiki',
      wikiPath: 'D:\\dev\\ei-llm-wiki',
      pluginPath: 'C:\\plugins\\ei-ai-skills',
    },
  });

  assert.equal(invocation.cwd, 'D:\\dev\\ei-llm-wiki');
  assert.equal(invocation.env.EI_LLM_WIKI_REPO, 'D:\\dev\\ei-llm-wiki');
  assert.ok(invocation.args.includes('--plugin-dir'));
  assert.ok(invocation.args.includes('C:\\plugins\\ei-ai-skills'));
  assert.ok(invocation.args.includes('--add-dir'));
  // 非交互评审不能停在提问上，也不自动信任仓库里的指令文件
  assert.ok(invocation.args.includes('--no-ask-user'));
  assert.ok(invocation.args.includes('--no-custom-instructions'));
  // skill 工具必须放行，否则 ei-llm-wiki 根本没法被调用
  assert.ok(defaultToolPolicy().some((entry) => entry.flag === '--allow-tool' && entry.value === 'skill'));
  // 只读约束不能因为挂载知识库而松掉
  const denied = invocation.args.filter((_, index) => invocation.args[index - 1] === '--deny-tool');
  assert.deepEqual(denied, ['shell', 'write']);
});

test('知识库不可用时不挂载任何目录，也不切换工作目录', () => {
  const invocation = buildReviewInvocation({ model: { id: 'claude-opus-5' }, knowledgeBase: null });
  assert.equal(invocation.cwd, undefined);
  assert.deepEqual(invocation.env, {});
  assert.ok(!invocation.args.includes('--plugin-dir'));
});

test('提示词写明 checkout 路径且禁止在子进程里跑 git', () => {
  const prompt = buildReviewPrompt({
    pullRequest: { number: 7, title: 't', description: '', sourceCommit: 'a', targetCommit: 'b' },
    scope: { inScopeFiles: ['src/a.ts'] },
    jiraSnapshot: { issues: [] },
    diffFiles: [],
    knowledgeBase: { active: true, skill: 'ei-llm-wiki', wikiPath: 'D:\\dev\\ei-llm-wiki', commit: 'abcdef1234567890' },
  });

  assert.match(prompt, /ei-ai-skills/);
  assert.match(prompt, /WIKI_REPO=D:\\dev\\ei-llm-wiki/);
  assert.match(prompt, /不要执行 git clone \/ fetch/);
  assert.match(prompt, /wikiConsulted/);
});

test('没有知识库时提示词要求如实写 queried=false，不得声称查过', () => {
  const prompt = buildReviewPrompt({
    pullRequest: { number: 7, title: 't', description: '', sourceCommit: 'a', targetCommit: 'b' },
    scope: { inScopeFiles: ['src/a.ts'] },
    jiraSnapshot: { issues: [] },
    diffFiles: [],
  });
  assert.match(prompt, /queried=false/);
});

/** 端到端：结果校验环节必须把编造的 wiki 引用挡在报告之外。 */
test('结果校验在知识库启用时核对 wiki 引用', () => {
  const base = {
    summaryZh: '摘要',
    summaryEn: 'summary',
    suggestedAction: 'comment_only',
    scopeCoverage: { reviewedFiles: ['src/a.ts'], contextFiles: [], notCovered: [] },
    criteriaChecks: [],
    uncertainties: [],
    findings: [],
  };
  const context = {
    scope: { inScopeFiles: ['src/a.ts'], fallback: true },
    jiraSnapshot: { issues: [] },
    knowledgeBase: { active: true, hasFile },
  };

  const missing = validateAiResult(base, context);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.code === 'wiki_consulted_missing'));

  const good = validateAiResult(
    {
      ...base,
      wikiConsulted: {
        queried: true,
        queries: ['cache'],
        references: [{ path: 'defects/2024-cache.md', titleZh: '缓存缺陷', noteZh: '同类回归' }],
      },
    },
    context,
  );
  assert.equal(good.ok, true, JSON.stringify(good.problems));
});
