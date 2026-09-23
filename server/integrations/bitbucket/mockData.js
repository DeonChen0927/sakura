/**
 * 演示数据：用于在没有真实凭据时跑通完整流程。
 * 内容为脱敏的构造样例，不代表真实 PR、真实需求或真实评审结论。
 */

export const MOCK_USER = {
  id: '{6f2c9c41-0d3a-4f5a-9a1b-3c7d8e2f1a55}',
  accountId: '557058:6f2c9c41-0d3a-4f5a-9a1b-3c7d8e2f1a55',
  displayName: 'Sakura Demo User',
  nickname: 'demo.user',
};

const scopeBlock = (entries) =>
  [
    'A review from team Seal is required due to changes in:',
    ...entries.map((entry) => `- ${entry}`),
  ].join('\n');

const diffFile = (path, status, hunks) => ({ path, oldPath: path, status, hunks });

const hunk = (oldStart, newStart, lines) => ({
  header: `@@ -${oldStart},${lines.filter((l) => l.type !== 'added').length} +${newStart},${lines.filter((l) => l.type !== 'removed').length} @@`,
  oldStart,
  newStart,
  lines,
});

const ctx = (content, oldLine, newLine) => ({ type: 'context', content, oldLine, newLine });
const add = (content, newLine) => ({ type: 'added', content, oldLine: null, newLine });
const del = (content, oldLine) => ({ type: 'removed', content, oldLine, newLine: null });

export const MOCK_PULL_REQUESTS = [
  {
    repository: 'example-org/example-repo',
    number: 2481,
    title: 'SEAL-1042 Cache study text annotations per viewport',
    description: [
      'Adds a per-viewport cache for text annotations so that switching studies does not re-fetch the full annotation set.',
      '',
      'Jira: SEAL-1042',
      '',
      scopeBlock([
        'imaging-module/text-annotation/src/main/java/com/example/imaging/text/AnnotationCache.java',
        'imaging-module/text-annotation/src/main/java/com/example/imaging/text/',
        'viewport-state',
      ]),
    ].join('\n'),
    author: { id: '{11111111-2222-3333-4444-555555555555}', accountId: '557058:11111111-2222-3333-4444-555555555555', name: 'Demo Author A' },
    sourceBranch: 'feature/SEAL-1042-annotation-cache',
    targetBranch: 'master',
    sourceCommit: '9f3c1a7be4d05c21a8f0b6d3e7c94a1f2b8d6e04',
    targetCommit: '41ab77c9d2e6f8135b0a4c92d7e3f60a15c8b9d2',
    lifecycleState: 'OPEN',
    isDraft: false,
    myReviewState: 'none',
    updatedAt: '2026-09-19T08:42:11.000Z',
    reviewers: [MOCK_USER.id],
    diff: [
      diffFile(
        'imaging-module/text-annotation/src/main/java/com/example/imaging/text/AnnotationCache.java',
        'modified',
        [
          hunk(18, 18, [
            ctx('public final class AnnotationCache {', 18, 18),
            ctx('', 19, 19),
            del('    private final Map<String, List<Annotation>> byStudy = new HashMap<>();', 20),
            add('    private final Map<String, List<Annotation>> byStudy = new HashMap<>();', 20),
            add('    private final Map<String, List<Annotation>> byViewport = new HashMap<>();', 21),
            ctx('', 22, 22),
            ctx('    public List<Annotation> get(String studyId) {', 23, 23),
          ]),
          hunk(40, 41, [
            ctx('    public void put(String studyId, List<Annotation> annotations) {', 40, 41),
            add('        byViewport.put(currentViewportId, annotations);', 42),
            add('        byStudy.put(studyId, annotations);', 43),
            del('        byStudy.put(studyId, annotations);', 41),
            ctx('    }', 42, 44),
            ctx('', 43, 45),
            add('    public List<Annotation> getForViewport(String viewportId) {', 46),
            add('        return byViewport.get(viewportId);', 47),
            add('    }', 48),
          ]),
        ],
      ),
      diffFile(
        'imaging-module/text-annotation/src/main/java/com/example/imaging/text/TextAnnotationService.java',
        'modified',
        [
          hunk(66, 66, [
            ctx('    public List<Annotation> loadAnnotations(String studyId) {', 66, 66),
            del('        return repository.findByStudy(studyId);', 67),
            add('        List<Annotation> cached = cache.getForViewport(viewportContext.id());', 67),
            add('        if (cached != null) {', 68),
            add('            return cached;', 69),
            add('        }', 70),
            add('        List<Annotation> loaded = repository.findByStudy(studyId);', 71),
            add('        cache.put(studyId, loaded);', 72),
            add('        return loaded;', 73),
            ctx('    }', 68, 74),
          ]),
        ],
      ),
      diffFile(
        'viewport-state/src/main/java/com/example/viewport/ViewportContext.java',
        'modified',
        [
          hunk(24, 24, [
            ctx('public class ViewportContext {', 24, 24),
            add('    private volatile String id;', 25),
            ctx('', 25, 26),
            ctx('    public String id() {', 26, 27),
            ctx('        return id;', 27, 28),
          ]),
        ],
      ),
      diffFile('docs/release-notes/2026-09.md', 'modified', [
        hunk(3, 3, [
          ctx('## 2026-09', 3, 3),
          add('- Annotation cache for viewport switches (SEAL-1042).', 4),
        ]),
      ]),
    ],
    comments: [],
  },
  {
    repository: 'example-org/example-repo',
    number: 2476,
    title: 'Refactor measurement toolbar layout',
    description: [
      'Cleans up the measurement toolbar layout and removes dead CSS.',
      '',
      'No Jira ticket, small UI cleanup.',
    ].join('\n'),
    author: { id: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}', accountId: '557058:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Demo Author B' },
    sourceBranch: 'chore/measurement-toolbar-layout',
    targetBranch: 'master',
    sourceCommit: '5c2e8d40b1a9f37e6d5c4b3a2918f7e6d5c4b3a2',
    targetCommit: '41ab77c9d2e6f8135b0a4c92d7e3f60a15c8b9d2',
    lifecycleState: 'OPEN',
    isDraft: false,
    myReviewState: 'none',
    updatedAt: '2026-09-18T15:04:52.000Z',
    reviewers: [MOCK_USER.id],
    diff: [
      diffFile('imaging-module/measurement/src/main/resources/toolbar.css', 'modified', [
        hunk(12, 12, [
          ctx('.toolbar {', 12, 12),
          del('  padding: 4px 6px;', 13),
          add('  padding: 6px 8px;', 13),
          ctx('}', 14, 14),
        ]),
      ]),
    ],
    comments: [],
  },
  {
    repository: 'example-org/example-repo',
    number: 2469,
    title: 'SEAL-0998 Harden DICOM tag sanitizer',
    description: [
      'Draft: hardening pass over the DICOM tag sanitizer before the security review.',
      '',
      scopeBlock(['imaging-module/dicom/src/main/java/com/example/imaging/dicom/TagSanitizer.java']),
    ].join('\n'),
    author: { id: '{99999999-8888-7777-6666-555555555555}', accountId: '557058:99999999-8888-7777-6666-555555555555', name: 'Demo Author C' },
    sourceBranch: 'draft/SEAL-0998-tag-sanitizer',
    targetBranch: 'master',
    sourceCommit: 'bb71f0a4c6d9e2318a5f7c0b4d6e8a1c3f5b7d90',
    targetCommit: '41ab77c9d2e6f8135b0a4c92d7e3f60a15c8b9d2',
    lifecycleState: 'OPEN',
    isDraft: true,
    myReviewState: 'changes_requested',
    updatedAt: '2026-09-17T11:20:03.000Z',
    reviewers: [MOCK_USER.id],
    diff: [
      diffFile('imaging-module/dicom/src/main/java/com/example/imaging/dicom/TagSanitizer.java', 'modified', [
        hunk(51, 51, [
          ctx('    public String sanitize(String raw) {', 51, 51),
          del('        return raw.replaceAll("[^\\\\p{Print}]", "");', 52),
          add('        if (raw == null) {', 52),
          add('            return "";', 53),
          add('        }', 54),
          add('        return raw.replaceAll("[^\\\\p{Print}]", "").trim();', 55),
          ctx('    }', 53, 56),
        ]),
      ]),
    ],
    comments: [],
  },
  {
    // 自己发起的 PR：即便机器人写了 Seal 范围标记，也必须整份评审。
    // 演示数据刻意让标记只覆盖其中一个文件，用来验证标记确实被忽略。
    repository: 'example-org/example-repo',
    number: 2490,
    title: 'Tighten viewport teardown ordering',
    description: [
      'Fixes a teardown ordering issue that leaked viewport listeners.',
      '',
      scopeBlock(['imaging-module/viewport/src/main/java/com/example/imaging/viewport/Teardown.java']),
    ].join('\n'),
    author: { id: MOCK_USER.id, accountId: MOCK_USER.accountId, name: MOCK_USER.displayName },
    sourceBranch: 'fix/viewport-teardown-order',
    targetBranch: 'master',
    sourceCommit: 'd41f8e0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e',
    targetCommit: '41ab77c9d2e6f8135b0a4c92d7e3f60a15c8b9d2',
    lifecycleState: 'OPEN',
    isDraft: false,
    myReviewState: 'none',
    updatedAt: '2026-09-20T09:15:00.000Z',
    reviewers: [],
    diff: [
      diffFile('imaging-module/viewport/src/main/java/com/example/imaging/viewport/Teardown.java', 'modified', [
        hunk(20, 20, [
          ctx('    public void dispose() {', 20, 20),
          del('        listeners.clear();', 21),
          add('        detachAll();', 21),
          add('        listeners.clear();', 22),
          ctx('    }', 22, 23),
        ]),
      ]),
      diffFile('imaging-module/viewport/src/test/java/com/example/imaging/viewport/TeardownTest.java', 'modified', [
        hunk(8, 8, [
          ctx('    @Test', 8, 8),
          add('    void detachesBeforeClearing() { }', 9),
          ctx('    void disposesCleanly() { }', 9, 10),
        ]),
      ]),
    ],
    comments: [],
  },
];

export const MOCK_JIRA_ISSUES = {
  'SEAL-1042': {
    key: 'SEAL-1042',
    summary: 'Avoid re-fetching text annotations when switching viewports',
    issueType: 'Story',
    status: 'In Progress',
    updatedAt: '2026-09-19T06:10:00.000Z',
    url: 'https://jira.example.invalid/browse/SEAL-1042',
    description:
      'Switching between viewports currently re-fetches the full annotation set for the study, causing a visible delay on large studies.',
    acceptanceCriteria: [
      { id: 'SEAL-1042-AC1', text: 'Switching back to a previously opened viewport does not trigger a new annotation fetch.' },
      { id: 'SEAL-1042-AC2', text: 'Annotation cache entries are cleared when the study is closed.' },
      { id: 'SEAL-1042-AC3', text: 'Cache access is safe when viewports are switched from multiple threads.' },
    ],
    links: [],
  },
  'SEAL-0998': {
    key: 'SEAL-0998',
    summary: 'Harden DICOM tag sanitizer against malformed input',
    issueType: 'Bug',
    status: 'In Progress',
    updatedAt: '2026-09-16T09:00:00.000Z',
    url: 'https://jira.example.invalid/browse/SEAL-0998',
    description: 'Malformed tags can reach the sanitizer and cause a NullPointerException.',
    acceptanceCriteria: [],
    links: [],
  },
};
