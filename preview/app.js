"use strict";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const stages = ["准备独立代码快照", "核对 Team Seal 与 Jira", "分析变更及关联代码", "整理中文报告与英文草稿"];
const demoModels = Object.freeze([
  Object.freeze({ name: "Claude Opus 5", id: "claude-opus-5" }),
  Object.freeze({ name: "Claude Sonnet 5", id: "claude-sonnet-5" })
]);
let configuredModel = demoModels[0];
const createAttribution = (model) => Object.freeze({ app: "Sakura", tool: "GitHub Copilot", model: model.name, modelId: model.id });
const demoPublisher = "本机使用者";
const files = [
  { name: "ReviewQueue.ts", path: "review-workspace/ReviewQueue.ts", rows: [
    ["", "", "@@ -38,9 +38,10 @@", "hunk"], [38, 38, "async function loadQueue(userId) {", ""],
    [39, 39, "  const items = await api.list(userId);", ""],
    [40, "", "  return items.filter(isPending);", "removed"],
    ["", 40, "  return items.filter(item =>", "added"],
    ["", 41, "    item.reviewers.includes(userId)", "added"],
    ["", 42, "  );", "added"],
    [41, 43, "}", ""], [42, 44, "", ""],
    [43, 45, "function openReview(item) {", ""],
    [44, 46, "  workspace.open(item.id);", ""],
    [45, 47, "}", ""]
  ] },
  { name: "ReviewPanel.tsx", path: "review-workspace/ReviewPanel.tsx", rows: [
    ["", "", "@@ -62,8 +62,7 @@", "hunk"],
    [62, 62, "const [loading, setLoading] = useState(false);", ""],
    [63, 63, "", ""],
    [64, 64, "async function startReview() {", ""],
    [65, "", "  if (loading) return;", "removed"],
    [66, 65, "  setLoading(true);", ""],
    [67, 66, "  await api.startReview(pr.id);", ""],
    [68, 67, "  setLoading(false);", ""],
    [69, 68, "}", ""]
  ] }
];

function demoFindings() {
  return [
    { id: "F1", level: "重要", title: "待评审列表未排除已合并的 PR", detail: "新的过滤只检查评审人，移除了待处理状态判断。已合并的 PR 仍可能出现在列表中，与 Jira AC-1 的约束不一致。", file: 0, line: 41, selected: true, deleted: false,
      comment: "This filter only checks the reviewer and no longer excludes merged or declined PRs. Could we retain the pending-state check as required by AC-1? Otherwise completed PRs can appear in the review queue." },
    { id: "F2", level: "重要", title: "连续点击可能启动重复评审任务", detail: "移除了运行中保护，在请求尚未结束时再次点击会再次调用 startReview。需要在交互入口和任务层避免同一 PR 的重复任务。", file: 1, line: 65, selected: true, deleted: false,
      comment: "Removing the in-flight guard allows repeated clicks to start multiple review jobs for the same PR. Please retain a guard and ensure the task endpoint rejects duplicate active jobs, as required by AC-2." }
  ];
}

const prs = [
  { id: 1284, title: "优化 PR 评审队列与启动交互", author: "Alex Morgan", jira: "DEMO-2048", state: "ready", remote: "尚未表态", round: 1, head: "a17c9e2", base: "d92f041", branch: "feature/review-queue", findings: demoFindings(), file: 0, summary: "", override: "", receipt: "", events: ["演示报告已生成 · 尚未发布"] },
  { id: 1281, title: "补充工作区加载状态", author: "Jamie Lee", jira: "DEMO-2042", state: "new", remote: "尚未表态", round: 0, head: "f23d617", base: "d92f041", branch: "feature/loading-state", findings: [], file: 0, summary: "", override: "", receipt: "", events: [] },
  { id: 1276, title: "修复评审工作区的刷新行为", author: "Sam Taylor", jira: "DEMO-2031", state: "stale", remote: "Changes requested", round: 1, head: "b804dc1", reviewedHead: "a17c9e2", base: "d92f041", branch: "fix/review-refresh", findings: demoFindings(), file: 0, summary: "", override: "", receipt: "", events: ["第 1 轮已模拟请求修改", "检测到新提交，旧报告已过期"] },
  { id: 1270, title: "完善评审任务异常提示", author: "Riley Park", jira: "DEMO-2019", state: "blocked", remote: "尚未表态", round: 0, head: "9c30e48", base: "d92f041", branch: "feature/task-feedback", findings: [], file: 0, summary: "", override: "", receipt: "", events: ["Jira 读取失败 · 演示 HTTP 403"] }
];
prs.forEach((pr) => { pr.attribution = createAttribution(configuredModel); });
let selectedId = 1284;
let page = "reviews";
let reportTab = "issues";
let search = "";
let filter = "all";
let task = null;
let toastTimer;
let publishTarget = null;
let undoDeleted = null;
const history = [];
const statusMap = {
  ready: ["待确认", "pink"], new: ["待开始", "gray"], stale: ["报告已过期", "amber"],
  blocked: ["信息缺失", "red"], running: ["评审中", "pink"], cancelled: ["已取消", "gray"], published: ["已模拟发布", "green"]
};
const current = () => prs.find((pr) => pr.id === selectedId);
const selectedFindings = (pr) => pr.findings.filter((finding) => !finding.deleted && finding.selected);
const isEditable = (pr) => pr.state === "ready";
const badge = (state) => `<span class="pill ${statusMap[state][1]}">${statusMap[state][0]}</span>`;

function aiSignature(pr) {
  const { app, tool, model } = pr.attribution;
  return `AI-assisted review by ${app} using ${tool} (${model}).\nHuman-reviewed and published by ${demoPublisher}.`;
}

function signedContent(pr, body) {
  const content = body.trim();
  return content ? { body: content, signature: aiSignature(pr), text: `${content}\n\n---\n${aiSignature(pr)}` } : null;
}

function publicationSnapshot(pr, decision) {
  const summaryBody = [
    pr.summary.trim(),
    decision === "approve" && pr.override.trim() ? `Approval rationale: ${pr.override.trim()}` : ""
  ].filter(Boolean).join("\n\n");
  return {
    decision,
    summary: signedContent(pr, summaryBody),
    comments: selectedFindings(pr).map((finding) => ({
      id: finding.id, path: files[finding.file].path, line: finding.line, content: signedContent(pr, finding.comment)
    }))
  };
}

function signedPreview(content) {
  return `<p>${escapeHtml(content.body)}</p><div class="ai-signature">${escapeHtml(content.signature)}</div>`;
}

function reportAttribution(pr) {
  if (!["ready", "stale", "published"].includes(pr.state)) return "";
  return `<div class="ai-attribution"><strong>AI 署名 · 演示样式</strong>AI 生成来源：${escapeHtml(pr.attribution.app)} / ${escapeHtml(pr.attribution.tool)} / ${escapeHtml(pr.attribution.model)}
    <small>PR #${pr.id} · 第 ${pr.round} 轮 · 评审源版本 ${pr.reviewedHead || pr.head}</small>
    <small>${pr.state === "published" ? `人工确认：${escapeHtml(demoPublisher)}（仅模拟发布）` : "人工确认：待审核发布"} · 本页未运行真实模型</small></div>`;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5500);
}

function render() {
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#page-name").textContent = { reviews: "PR 评审", history: "评审历史", settings: "连接设置" }[page];
  if (page === "history") return renderHistory();
  if (page === "settings") return renderSettings();
  $("#app").innerHTML = `
    <section class="page-heading"><div><span class="eyebrow">A LITTLE CLARITY, EVERY REVIEW</span><h1>把注意力，留给重要的代码。</h1><p>你的 Team Seal 评审工作台。先看证据，再做决定。</p></div><button class="button" data-action="refresh">↻ 刷新列表</button></section>
    <div class="summary-row">
      <div class="summary-card"><span class="summary-symbol" aria-hidden="true">▤</span><div><strong>4</strong><small>演示 PR</small></div></div>
      <div class="summary-card"><span class="summary-symbol" aria-hidden="true">◇</span><div><strong>${prs.filter((pr) => pr.state === "ready").length}</strong><small>报告待你确认</small></div></div>
      <div class="summary-card"><span class="summary-symbol" aria-hidden="true">!</span><div><strong>${prs.filter((pr) => ["stale", "blocked"].includes(pr.state)).length}</strong><small>需要先处理</small></div></div>
    </div>
    <div class="workspace"><section class="pr-list" aria-label="PR 列表">
      <div class="list-heading"><strong>分配给我的 PR</strong><span class="muted">演示仓库</span></div>
      <div class="list-tools"><input id="search" class="search" aria-label="搜索 PR 或 Jira" placeholder="搜索 PR、标题或 Jira…" value="${escapeHtml(search)}">
      <select id="filter" aria-label="筛选本地评审状态"><option value="all">全部本地状态</option><option value="ready">报告待确认</option><option value="new">待开始</option><option value="attention">需要处理</option><option value="published">已模拟发布</option></select></div>
      <div id="pr-cards"></div><div class="list-footnote">所有 PR、代码及 Jira 均为虚构数据。<br>刷新页面会重置全部演示操作。</div>
    </section><div><article class="review" id="review"></article><div class="prototype-controls"><span>原型 v0.4 · 手动确认前不发布任何内容</span><button class="button ghost small" data-action="stale" ${["ready", "published"].includes(current().state) ? "" : "disabled"}>模拟新提交</button></div></div></div>`;
  $("#filter").value = filter;
  renderCards();
  renderReview();
}

function renderCards() {
  const visible = prs.filter((pr) => {
    const matchesSearch = `${pr.id} ${pr.title} ${pr.jira}`.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || pr.state === filter || (filter === "attention" && ["blocked", "stale"].includes(pr.state));
    return matchesSearch && matchesFilter;
  });
  $("#pr-cards").innerHTML = visible.length ? visible.map((pr) => `<button class="pr-card ${pr.id === selectedId ? "selected" : ""}" data-pr="${pr.id}" aria-pressed="${pr.id === selectedId}">
    <span class="pr-card-top"><span>#${pr.id} · OPEN</span>${badge(pr.state)}</span><h3>${escapeHtml(pr.title)}</h3>
    <span class="pr-card-bottom"><span>${escapeHtml(pr.author)}</span><span>${pr.jira}</span></span>
    <span class="remote-state">远端评审 · ${pr.remote}</span></button>`).join("") : `<div class="empty"><h3>没有匹配的 PR</h3><p>试试其他关键词或切换筛选条件。<br>当前工作区仍保留上次选择。</p><button class="button small" data-action="clear-search">清除筛选</button></div>`;
}

function renderReview() {
  const pr = current();
  const running = pr.state === "running";
  const startLabel = pr.round ? "重新评审" : "开始评审";
  const count = selectedFindings(pr).length;
  $("#review").innerHTML = `
    <header class="review-header"><div class="review-title-row"><div><div class="meta-row"><span class="pill gray">PR #${pr.id}</span>${badge(pr.state)}<span>第 ${pr.round || "—"} 轮</span></div><h2>${escapeHtml(pr.title)}</h2><div class="meta-row"><span>${escapeHtml(pr.author)}</span><span>·</span><span>远端评审：${pr.remote}</span></div></div>
    <button class="button ${running ? "" : "soft"}" data-action="${running ? "cancel-run" : "start"}" ${(pr.state === "blocked" || (task && !running)) ? "disabled" : ""}>${running ? "取消评审" : `▷ ${startLabel}`}</button></div>
    <div class="branch-row"><code>${pr.branch}</code><span>→</span><code>main</code><span>源 ${pr.head} / 目标 ${pr.base}</span></div></header>
    <div class="context-strip"><span class="pill green">✓ Team Seal · 2 个文件</span><span class="pill ${pr.state === "blocked" ? "red" : "green"}">${pr.state === "blocked" ? "!" : "✓"} ${pr.jira} · ${pr.state === "blocked" ? "读取失败" : "需求已载入"}</span>${pr.round ? `<span class="pill gray">本轮：${escapeHtml(pr.attribution.model)} · 模拟</span>` : ""}<span class="pill gray">新评审：${escapeHtml(configuredModel.name)}</span></div>
    ${pr.state === "stale" ? `<div class="notice warning"><strong>报告已过期，不能发布。</strong> 源版本已从 ${pr.reviewedHead} 更新为 ${pr.head}。旧报告仅供阅读，请重新评审。</div>` : ""}
    ${pr.state === "blocked" ? `<div class="notice error"><strong>前置检查未通过：无法读取 Jira。</strong> 演示账号没有 ${pr.jira} 的读取权限（403）。请补齐权限后重试，不会降级为“通过”。</div>` : ""}
    ${pr.state === "published" ? `<div class="notice neutral"><strong>${escapeHtml(pr.receipt)}</strong> 未发生真实 API 写入。已发布轮次只读；继续评审会建立新轮次。</div>` : ""}
    <div class="review-split"><section class="code-panel" aria-label="代码差异">${renderDiff(pr)}</section><section class="report-panel" aria-label="评审报告">
    ${reportAttribution(pr)}
    <div class="report-tabs" role="tablist" aria-label="报告内容">${[["issues", "评审意见"], ["jira", "Jira 核对"], ["logs", "运行记录"]].map(([tab, name]) => `<button class="report-tab ${reportTab === tab ? "active" : ""}" data-tab="${tab}" role="tab" aria-selected="${reportTab === tab}" aria-controls="report-content" id="tab-${tab}">${name}${tab === "issues" && pr.findings.length ? ` <span class="muted">${pr.findings.filter((f) => !f.deleted).length}</span>` : ""}</button>`).join("")}</div>
    <div class="report-body" id="report-content" role="tabpanel" aria-labelledby="tab-${reportTab}">${renderReport(pr)}</div></section></div>
    <footer class="review-footer"><p><strong id="selection-count">已选择 ${count} 条英文评论</strong>仅在确认发布后更新 Bitbucket</p><button class="button primary" data-action="preview" ${isEditable(pr) ? "" : "disabled"}>预览发布 <span aria-hidden="true">→</span></button></footer>`;
}

function renderDiff(pr) {
  const file = files[pr.file];
  return `<div class="panel-title"><span>代码差异 <span class="muted">/ Team Seal</span></span><span class="diff-stats">+3 <span>−2</span></span></div>
    <div class="file-tabs">${files.map((entry, index) => `<button class="file-tab ${pr.file === index ? "active" : ""}" data-file="${index}" aria-pressed="${pr.file === index}">${entry.name}</button>`).join("")}</div>
    <div class="file-path">${file.path}</div><div class="diff-scroll"><table class="diff-table" aria-label="${escapeHtml(file.name)} 演示代码差异"><tbody>${file.rows.map(([oldLine, newLine, code, kind]) => `<tr class="${kind} ${pr.focusLine === newLine ? "focus-line" : ""}" ${newLine !== "" ? `data-line="${newLine}"` : ""}><th scope="row">${oldLine}</th><th scope="row">${newLine}</th><td class="mark">${kind === "added" ? "+" : kind === "removed" ? "−" : ""}</td><td>${escapeHtml(code)}</td></tr>`).join("")}</tbody></table></div>
    <div class="code-note"><strong>评审范围清晰可见</strong>范围来源：<br><code>A review from team Seal is required due to changes in:</code><br><code>review-workspace/</code><br><br>关联代码可只读参考，正式意见只针对本范围。以上代码与映射均为演示。</div>`;
}

function renderReport(pr) {
  if (reportTab === "logs") {
    return `<div class="report-summary"><strong>本轮事件 · 演示日志</strong><p>不会展示模型内部推理。没有调用真实 Copilot session。</p></div><ol class="timeline">${(pr.events.length ? pr.events : ["尚未启动评审"]).map((event) => `<li>${escapeHtml(event)}<small>PR #${pr.id} · 第 ${pr.round || "—"} 轮</small></li>`).join("")}</ol>`;
  }
  if (pr.state === "blocked") return `<div class="empty"><span class="empty-icon" aria-hidden="true">⊘</span><h3>先补齐需求，再开始评审</h3><p>缺少 Jira 读取权限。<br>没有足够证据时，不生成通过结论。</p><button class="button small" data-page="settings">查看连接设置</button></div>`;
  if (pr.state === "running") {
    return `<div class="empty"><span class="empty-icon" aria-hidden="true">✳</span><h3>正在模拟第 ${pr.round} 轮评审</h3><p>演示阶段动画，不会启动真实 AI。</p><div class="progress-stages" role="status">${stages.map((stage, i) => `<div class="stage ${i === task.step ? "current" : i < task.step ? "done" : ""}">${i < task.step ? "✓" : `${i + 1}.`} ${stage}</div>`).join("")}</div></div>`;
  }
  if (["new", "cancelled"].includes(pr.state)) return `<div class="empty"><span class="empty-icon" aria-hidden="true">◇</span><h3>${pr.state === "cancelled" ? "本轮评审已取消" : "准备好开始这一轮了吗？"}</h3><p>将结合 Team Seal 代码范围与 Jira 标准。<br>完整报告生成前，发布操作始终锁定。</p><button class="button soft" data-action="start" ${task ? "disabled" : ""}>开始模拟评审</button></div>`;
  if (reportTab === "jira") {
    return `<div class="report-summary"><strong>${pr.jira} · 需求验收核对</strong><p>虚构需求快照 · 2026-09-20<br>这些标准来自演示数据，不是 AI 补造的实际需求。</p></div>
    <div class="criterion"><span class="pill red">AC-1 · 不符合</span><strong>仅显示尚需处理的 PR</strong><p>ReviewQueue.ts:41 缺少状态过滤，已合并项可能进入列表。</p></div>
    <div class="criterion"><span class="pill red">AC-2 · 不符合</span><strong>同一 PR 不能重复启动任务</strong><p>ReviewPanel.tsx:65 删除运行中保护，需补充入口和服务端约束。</p></div>
    <div class="criterion"><span class="pill amber">AC-3 · 需人工验证</span><strong>真实网络环境下的操作体验</strong><p>静态代码不能证明响应体验。不能将这一项标记为已通过。</p></div>`;
  }
  const active = pr.findings.filter((finding) => !finding.deleted);
  return `<div class="report-summary"><strong>AI 建议：Request changes</strong><p>发现 2 个需要关注的问题，均在 Team Seal 范围内。<br>2 / 2 个范围内文件已模拟覆盖；最终决定由你作出。</p></div>
    ${active.map((finding) => `<article class="finding ${finding.selected ? "" : "excluded"}" data-finding="${finding.id}">
      <div class="finding-top"><span class="pill red">${finding.level}</span><label class="checkbox-label"><input type="checkbox" data-select="${finding.id}" ${finding.selected ? "checked" : ""} ${isEditable(pr) ? "" : "disabled"}>发布此意见</label></div>
      <h3>${escapeHtml(finding.title)}</h3><p>${escapeHtml(finding.detail)}</p>
      <button class="location" data-locate="${finding.id}">${files[finding.file].name}:${finding.line} ↗</button>
      <label class="field-label" for="comment-${finding.id}">英文发布草稿 <span>你可修改</span></label>
      <textarea id="comment-${finding.id}" data-comment="${finding.id}" rows="4" ${isEditable(pr) ? "" : "disabled"}>${escapeHtml(finding.comment)}</textarea>
      <span class="signature-hint">发布时附加固定 AI 署名 · 正文修改不移除来源标识</span>
      <div class="finding-foot"><span>${finding.id} · 新版代码行 ${finding.line}</span><button class="button ghost small" data-delete="${finding.id}" ${isEditable(pr) ? "" : "disabled"}>删除草稿</button></div></article>`).join("")}
    ${!active.length ? `<div class="empty"><h3>没有保留的评论草稿</h3><p>AI 原始结论仍保留，删除评论并不表示问题已经解决。</p></div>` : ""}
    ${undoDeleted && undoDeleted.prId === pr.id && isEditable(pr) ? `<button class="button small" data-action="undo-delete">撤销最近一次删除</button>` : ""}`;
}

function renderHistory() {
  $("#app").innerHTML = `<section class="page-heading"><div><span class="eyebrow">EVERY DECISION HAS A STORY</span><h1>评审历史</h1><p>每一轮分析、每一次人工决定，都有迹可循。</p></div><button class="button" data-page="reviews">返回工作台</button></section>
    <div class="notice neutral">这里只展示当前页面内的模拟事件，不是完整历史回放。刷新页面会重置。正式版将持久化每轮报告、修订和回执。</div>
    <section class="content-card" style="margin-top:20px"><div class="section-heading"><h3>本次演示记录</h3><span class="muted">${history.length} 条事件</span></div>
    ${history.length ? `<div class="table-scroll"><table class="history-table"><thead><tr><th>PR / 轮次</th><th>源版本</th><th>本轮模型</th><th>事件</th><th>时间</th><th>操作</th></tr></thead><tbody>${history.slice().reverse().map((event) => `<tr><td>#${event.prId} · 第 ${event.round} 轮</td><td><code>${event.head}</code></td><td>${escapeHtml(event.model)}</td><td>${escapeHtml(event.message)}</td><td>${event.time}</td><td><button class="button small" data-open-pr="${event.prId}">查看当前工作区</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">◷</span><h3>这里会留下你的评审足迹</h3><p>先尝试模拟发布或启动新一轮评审。</p></div>`}</section>`;
}

function renderSettings() {
  $("#app").innerHTML = `<section class="page-heading"><div><span class="eyebrow">LOCAL FIRST, HUMAN ALWAYS</span><h1>连接与数据边界</h1><p>本机工作台，不等于离线 AI。外部服务访问需要你的授权。</p></div></section>
    <div class="notice warning"><strong>原型不接收真实凭据。</strong> 请勿把 Token 填进文档、浏览器存储或聊天。原始需求中的凭据建议撤销并重新生成。</div>
    <div class="settings-grid">
      <section class="content-card"><span class="pill gray">未连接 · 原型</span><h2>Bitbucket</h2><p>读取 PR、diff、评审人；仅在你确认后发布评论与状态。</p><div class="setting-value">目标仓库：example-org/example-repo</div><p>正式版：安全凭据输入、实际用户身份确认、读写权限检测。</p></section>
      <section class="content-card"><span class="pill gray">未连接 · 原型</span><h2>Jira</h2><p>读取关联需求、验收标准及版本快照，提供评审依据。</p><div class="setting-value">实例地址与验收字段：待确认</div><p>读取失败或需求缺失时阻断，不用 AI 臆造验收标准。</p></section>
      <section class="content-card"><span class="pill gray">未调用 · 原型</span><h2>Copilot CLI</h2><p>使用本机登录身份；模型可配置，不静默降级。</p>
        <label class="field-label" for="review-model">评审模型</label>
        <select id="review-model" aria-describedby="model-help">${demoModels.map((model, index) => `<option value="${model.id}" ${model.id === configuredModel.id ? "selected" : ""}>${model.name}${index === 0 ? "（默认）" : ""}</option>`).join("")}</select>
        <p class="help" id="model-help">选择后即应用于新评审。已有报告与运行中任务不变。仅本页保存，刷新重置。</p>
        <div class="setting-value" id="configured-model-id">${escapeHtml(configuredModel.id)}</div><p>以上是演示选项，未验证账号权限。正式版提供真实可用模型并在本地持久保存。</p></section>
    </div>
    <section class="content-card"><h2>数据只留在该留的地方</h2><p>正式版计划使用独立 Git 缓存与本地数据库，不触碰你的日常开发工作区。凭据由操作系统保护存储，不交给 AI 发布。</p><p>代码与 Jira 上下文会按组织允许的方式提供给 Copilot。缓存保留与清理策略待确认。</p><p>本原型仅用页面内存，未使用 Cookie 或 localStorage 保存任何数据。</p></section>`;
}

function record(pr, message) {
  history.push({ prId: pr.id, round: pr.round, head: pr.head, model: pr.attribution.model, message, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) });
  pr.events.push(message);
}

function startReview() {
  const pr = current();
  if (task || pr.state === "blocked") return;
  if (pr.state === "ready" && !window.confirm("开始新一轮模拟评审？当前人工草稿将重置。正式产品会归档旧轮次；本原型仅保留事件记录。")) return;
  pr.round += 1;
  pr.state = "running";
  pr.findings = [];
  pr.focusLine = null;
  pr.summary = "";
  pr.override = "";
  pr.receipt = "";
  pr.publication = null;
  pr.attribution = createAttribution(configuredModel);
  pr.reviewedHead = pr.head;
  undoDeleted = null;
  record(pr, "开始新一轮模拟评审");
  task = { prId: pr.id, step: 0, timer: null };
  reportTab = "issues";
  task.timer = setInterval(() => {
    task.step += 1;
    if (task.step >= stages.length) {
      clearInterval(task.timer);
      task = null;
      pr.state = "ready";
      pr.findings = demoFindings();
      record(pr, "演示报告完成 · 建议 Request changes · 待人工确认");
      toast(`#${pr.id} 模拟报告已生成，没有调用真实 Copilot。`);
    } else {
      pr.events.push(`${stages[task.step - 1]} · 模拟完成`);
    }
    render();
  }, 1050);
  render();
}

function cancelReview() {
  if (!task || task.prId !== selectedId) return;
  const pr = current();
  clearInterval(task.timer);
  task = null;
  pr.state = "cancelled";
  record(pr, "用户取消模拟评审 · 无可发布报告");
  render();
  toast("本轮已取消。未完成的结果不能发布。");
}

function openPublish() {
  const pr = current();
  if (!isEditable(pr)) return;
  publishTarget = { id: pr.id, head: pr.head, base: pr.base, round: pr.round };
  $("#publish-form").reset();
  $("#publish-context").textContent = `PR #${pr.id} · 第 ${pr.round} 轮 · 源 ${pr.head} / 目标 ${pr.base} · 确认时再次检查版本`;
  $("#review-summary").value = pr.summary;
  $("#override-reason").value = pr.override;
  updatePublishValidation();
  $("#publish-dialog").showModal();
}

function updatePublishValidation() {
  if (!publishTarget) return;
  const pr = prs.find((item) => item.id === publishTarget.id);
  const decision = $("#publish-form").elements.decision.value;
  const summary = $("#review-summary").value.trim();
  const override = $("#override-reason").value.trim();
  const findings = selectedFindings(pr);
  pr.summary = $("#review-summary").value;
  pr.override = $("#override-reason").value;
  $("#override-area").hidden = decision !== "approve";
  const snapshot = publicationSnapshot(pr, decision);
  $("#publish-count").textContent = `${snapshot.comments.length} 条 · 每条独立署名`;
  $("#publish-comments").innerHTML = snapshot.comments.length ? snapshot.comments.map((comment) => `<article class="preview-comment"><small>${escapeHtml(comment.path)}:${comment.line}</small>${comment.content ? signedPreview(comment.content) : '<p class="validation">正文为空，请返回编辑；署名不能替代有效内容。</p>'}</article>`).join("") : `<p class="muted">没有选择问题评论。可以填写英文总结或选择批准。</p>`;
  $("#publish-summary-preview").innerHTML = snapshot.summary ? `<article class="preview-summary preview-comment">${signedPreview(snapshot.summary)}</article>` : `<p class="muted">未填写总结或批准理由，不发布仅含署名的空总结。</p>`;
  let error = "";
  if (!isEditable(pr) || pr.head !== publishTarget.head || pr.base !== publishTarget.base || pr.round !== publishTarget.round) error = "本轮已过期或状态改变。请关闭预览并重新评审。";
  else if (!decision) error = "请手动选择评审动作。";
  else if (findings.some((finding) => !finding.comment.trim())) error = "所选英文评论不能为空，请返回编辑或取消选择。";
  else if (decision === "approve" && !override) error = "AI 建议请求修改；批准前请填写英文覆盖理由。";
  else if ((decision === "changes" || decision === "comment") && !findings.length && !summary) error = "至少选择一条评论，或填写非空英文总结 / 理由。";
  else if (/[\u3400-\u9fff]/.test([summary, decision === "approve" ? override : "", ...findings.map((finding) => finding.comment)].join("\n"))) error = "发布内容应为英文；当前检测到中文，请返回修改。";
  $("#publish-error").textContent = error;
  $("#confirm-publish").disabled = Boolean(error);
  $("#confirm-publish").textContent = { approve: "模拟确认批准", changes: "模拟确认请求修改", comment: "模拟仅发布评论" }[decision] || "请选择评审动作";
  return !error;
}

function confirmPublish(event) {
  event.preventDefault();
  if (!updatePublishValidation()) return;
  const pr = prs.find((item) => item.id === publishTarget.id);
  const decision = $("#publish-form").elements.decision.value;
  if (decision === "approve" && !window.confirm("AI 建议请求修改。你已填写批准理由，仍要模拟 Approve 吗？")) return;
  pr.publication = publicationSnapshot(pr, decision);
  if (decision === "approve") pr.remote = "Approved";
  if (decision === "changes") pr.remote = "Changes requested";
  const action = { approve: "Approve", changes: "Request changes", comment: "仅评论，保留原评审状态" }[decision];
  pr.receipt = `已模拟发布 ${pr.publication.comments.length} 条问题评论${pr.publication.summary ? "及英文总结" : ""} · 均含 AI 署名 · ${action}`;
  pr.state = "published";
  record(pr, pr.receipt);
  $("#publish-dialog").close();
  publishTarget = null;
  render();
  toast("模拟操作完成。没有向 Bitbucket 发送任何内容。");
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button, .brand");
  if (!button || button.disabled) return;
  if (button.matches(".brand") || button.dataset.page) {
    if (button.matches(".brand")) event.preventDefault();
    page = button.dataset.page || "reviews";
    render();
    return;
  }
  if (button.dataset.openPr || button.dataset.pr) {
    selectedId = Number(button.dataset.openPr || button.dataset.pr);
    page = "reviews";
    reportTab = "issues";
    render();
    return;
  }
  if (button.dataset.tab) { reportTab = button.dataset.tab; renderReview(); return; }
  if (button.dataset.file !== undefined) { current().file = Number(button.dataset.file); current().focusLine = null; renderReview(); return; }
  if (button.dataset.locate) {
    const finding = current().findings.find((item) => item.id === button.dataset.locate);
    current().file = finding.file;
    current().focusLine = finding.line;
    renderReview();
    $(`[data-line="${finding.line}"]`)?.scrollIntoView({ behavior: "auto", block: "nearest" });
    return;
  }
  if (button.dataset.delete && isEditable(current())) {
    const finding = current().findings.find((item) => item.id === button.dataset.delete);
    finding.deleted = true;
    undoDeleted = { prId: current().id, id: finding.id };
    renderReview();
    toast("已删除人工草稿。可点击“撤销最近一次删除”；AI 原始结论不变。");
    return;
  }
  switch (button.dataset.action) {
    case "refresh": toast("演示列表已刷新。没有连接真实 Bitbucket，也不会自动启动评审。"); break;
    case "clear-search": search = ""; filter = "all"; render(); break;
    case "start": startReview(); break;
    case "cancel-run": cancelReview(); break;
    case "preview": openPublish(); break;
    case "undo-delete": {
      if (!undoDeleted || undoDeleted.prId !== current().id || !isEditable(current())) break;
      current().findings.find((finding) => finding.id === undoDeleted.id).deleted = false;
      undoDeleted = null;
      renderReview();
      break;
    }
    case "stale": {
      const pr = current();
      if (!["ready", "published"].includes(pr.state)) break;
      pr.reviewedHead = pr.head;
      pr.head = `d${(parseInt(pr.head.slice(1), 16) + 113).toString(16).padStart(6, "0").slice(-6)}`;
      pr.state = "stale";
      record(pr, "模拟收到新提交 · 报告已过期，发布已锁定");
      render();
      toast("旧报告已转为只读。必须重新评审，不能绕过版本检查。");
      break;
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "search") { search = event.target.value; renderCards(); }
  if (event.target.dataset.comment && isEditable(current())) {
    current().findings.find((finding) => finding.id === event.target.dataset.comment).comment = event.target.value;
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "review-model") {
    const model = demoModels.find((entry) => entry.id === event.target.value);
    if (!model) {
      event.target.value = configuredModel.id;
      toast("无效的模型选择，未更改配置。请从演示列表中重新选择。");
      return;
    }
    configuredModel = model;
    $("#configured-model-id").textContent = model.id;
    toast(`新评审模型已设为 ${model.name}（仅本页）。已有报告和运行中任务不变。`);
  }
  if (event.target.id === "filter") { filter = event.target.value; renderCards(); }
  if (event.target.dataset.select && isEditable(current())) {
    const finding = current().findings.find((item) => item.id === event.target.dataset.select);
    finding.selected = event.target.checked;
    event.target.closest(".finding").classList.toggle("excluded", !finding.selected);
    $("#selection-count").textContent = `已选择 ${selectedFindings(current()).length} 条英文评论`;
  }
});
$("#publish-form").addEventListener("input", updatePublishValidation);
$("#publish-form").addEventListener("change", updatePublishValidation);
$("#publish-form").addEventListener("submit", confirmPublish);
$("#close-dialog").addEventListener("click", () => $("#publish-dialog").close());
$("#cancel-dialog").addEventListener("click", () => $("#publish-dialog").close());
$("#publish-dialog").addEventListener("close", () => { publishTarget = null; });
render();
