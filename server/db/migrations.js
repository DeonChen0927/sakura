/**
 * 结构化保存 PR 快照、轮次、发现、人工修订、发布批次和审计事件（第 7 章）。
 * AI 原始结果与人工修订分表存放，人工不可覆盖 AI 原文（FR-06）。
 */
export const migrations = [
  {
    id: '001-initial',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE pull_requests (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        author_name TEXT,
        author_id TEXT,
        source_branch TEXT,
        target_branch TEXT,
        source_commit TEXT,
        target_commit TEXT,
        lifecycle_state TEXT NOT NULL,
        is_draft INTEGER NOT NULL DEFAULT 0,
        my_review_state TEXT NOT NULL DEFAULT 'none',
        updated_at TEXT,
        synced_at TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE (repository, number)
      );

      CREATE TABLE review_rounds (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        model_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_verified INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        source_commit TEXT NOT NULL,
        target_commit TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        scope_json TEXT,
        jira_snapshot_json TEXT,
        ai_result_json TEXT,
        summary_zh TEXT,
        summary_en_draft TEXT,
        integration_mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (pull_request_id, round_number)
      );

      CREATE TABLE round_events (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        created_at TEXT NOT NULL
      );

      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        finding_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        title_zh TEXT NOT NULL,
        detail_zh TEXT NOT NULL,
        evidence_json TEXT,
        file_path TEXT,
        old_line INTEGER,
        new_line INTEGER,
        anchor_kind TEXT NOT NULL DEFAULT 'line',
        comment_en TEXT NOT NULL,
        in_scope INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (round_id, finding_key)
      );

      CREATE TABLE finding_revisions (
        finding_id TEXT PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
        comment_en TEXT,
        selected INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE round_summary_revisions (
        round_id TEXT PRIMARY KEY REFERENCES review_rounds(id) ON DELETE CASCADE,
        summary_en TEXT,
        override_reason_en TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE publish_batches (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        publisher_name TEXT NOT NULL,
        publisher_id TEXT,
        input_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        failure_reason TEXT
      );

      CREATE TABLE publish_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        finding_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        remote_comment_id TEXT,
        error_message TEXT,
        dedupe_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_rounds_pr ON review_rounds(pull_request_id);
      CREATE INDEX idx_findings_round ON findings(round_id);
      CREATE INDEX idx_events_round ON round_events(round_id);
      CREATE INDEX idx_batches_round ON publish_batches(round_id);
      CREATE INDEX idx_audit_created ON audit_events(created_at);
    `,
  },
  {
    id: '002-finding-carryover',
    sql: `
      CREATE TABLE finding_carryover (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        previous_round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        previous_finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        current_finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
        verdict TEXT NOT NULL,
        note TEXT,
        decided_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL,
        UNIQUE (round_id, previous_finding_id)
      );

      CREATE INDEX idx_carryover_round ON finding_carryover(round_id);
    `,
  },
  {
    // 远端不再把 PR 列为“待我评审”时（合并、关闭、被移出评审人、或早期演示数据遗留），
    // 本地有评审痕迹的行不能删，只标记；没有痕迹的行由同步直接清理。
    id: '003-pr-remote-missing',
    sql: `
      ALTER TABLE pull_requests ADD COLUMN remote_missing INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pull_requests ADD COLUMN remote_missing_at TEXT;
    `,
  },
  {
    // 远端不再列为“待我评审”的 PR（已合并、已关闭、被移出评审人）直接退出工作台。
    // 有评审痕迹的行仍留在库里，只是被归档：评审历史必须还能查到。
    id: '004-pr-archive',
    sql: `
      ALTER TABLE pull_requests ADD COLUMN archived_at TEXT;
      UPDATE pull_requests SET archived_at = remote_missing_at WHERE remote_missing = 1;
    `,
  },
  {
    // 由我本人、或 Team Seal 成员发起的 PR 要整份评审（不按 Seal 范围），
    // 因此必须持久化作者的 Bitbucket account_id —— teams.yaml 用的就是这个标识，
    // 与 PR 里的 uuid 不是同一个东西，不能互相替代。
    id: '005-pr-author-account',
    sql: `
      ALTER TABLE pull_requests ADD COLUMN author_account_id TEXT;
      ALTER TABLE pull_requests ADD COLUMN authored_by_me INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // 本轮实际使用的知识库快照（ei-ai-skills / ei-llm-wiki checkout 与版本），
    // 以及每条发现引用的 wiki 页面。报告与历史必须能看出结论依据了哪一版知识库。
    id: '006-knowledge-base',
    sql: `
      ALTER TABLE review_rounds ADD COLUMN knowledge_base_json TEXT;
      ALTER TABLE findings ADD COLUMN wiki_refs_json TEXT;
    `,
  },
];
