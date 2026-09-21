# Sakura · 本地工作台

Sakura 是一个**只在本机运行**的个人工作台。第一版提供 Bitbucket PR 评审能力：结合 Jira 需求与验收标准，调用本机 Copilot CLI 生成评审报告，由你人工确认后再发布评论与评审状态。

需求唯一来源：[`requirements.md`](./requirements.md)；界面方案：[`ui-ux.md`](./ui-ux.md)。

## 运行

```powershell
cd D:\dev\app\sakura
npm start          # http://127.0.0.1:7420
npm test           # 端到端回归（node --test）
```

- 需要 Node.js ≥ 22.5（开发与验证使用 24.15）。
- **零第三方依赖**：数据库用内置 `node:sqlite`，前端无构建、无 CDN，断网也能打开。

## 本机边界

- HTTP 服务只监听 `127.0.0.1`，并校验回环 Host 与同源 Origin。
- 所有变更请求需要本地会话 cookie 与 `x-sakura-csrf` 头。
- 凭据用 Windows DPAPI（CurrentUser）加密存放于 `data/secrets/`；非 Windows 回退为本机密钥 AES-256-GCM。
  - DPAPI 通过 `powershell.exe` 调用，会剥离继承来的 `PSModulePath`（否则 Windows PowerShell 5.1 会误加载 PowerShell 7 的 Security 模块而失败），并对该进程使用 `-ExecutionPolicy Bypass`。
  - 若被组策略彻底禁止，可用 `SAKURA_CREDENTIAL_BACKEND=file` 启动，显式降级为本机密钥文件加密（保护强度更低，不会静默发生）。
- Token 绝不写入数据库、日志、AI 提示或导出内容。

## 数据目录

默认 `./data`（可用环境变量 `SAKURA_DATA_DIR` 覆盖）：

| 路径 | 内容 |
| --- | --- |
| `data/sakura.db` | 设置、PR 缓存、评审轮次、发现与修订、跨轮跟踪、发布批次、审计事件 |
| `data/secrets/` | 受保护的凭据 |
| `data/logs/` | 脱敏后的运行日志 |
| `data/repo-cache/` | 被评审仓库的只读裸仓库缓存 |

删除 `data/` 即可完全重置。

## mock / live 切换

在「连接设置」页切换集成模式，或直接设置环境变量 `SAKURA_INTEGRATION_MODE=mock|live`。

- **mock（默认）**：内置三个演示 PR，覆盖「可评审」「缺 Team Seal 标记」「Draft + 无验收标准」三种情况。所有发布只写入本地，界面全程显示「演示模式」标记。
- **live**：使用你录入的 Bitbucket / Jira 凭据与本机 `copilot` CLI。未完成验证的能力会明确报错，不会用硬编码值伪装成功。

### 对接真实 Bitbucket Cloud

Bitbucket Cloud 的 **App password 已废弃**（2026-07-28 起彻底失效），因此认证方式在「连接设置 → Bitbucket」中显式选择，不做猜测：

| 方式 | 适用凭据 | 需要填写 |
| --- | --- | --- |
| Basic（默认） | Atlassian 账号 API token（<https://id.atlassian.com/manage-profile/security/api-tokens>） | Atlassian 账号邮箱 + 把 API token 存为 Bitbucket 凭据 |
| Bearer | 仓库 / 工作区访问令牌、OAuth access token | 仅存令牌，无需邮箱 |

操作顺序：

1. 「连接设置 → Bitbucket」填写仓库（`workspace/repository`）、认证方式、邮箱（Basic 时）、API 基地址；
2. 在「凭据」卡片录入 Bitbucket token —— token 只写入本机加密存储，不进日志、不回显；
3. 把集成模式切换为 **live**，点「测试 bitbucket」，成功后会显示 API 返回的真实身份；
4. 回到 PR 列表点「同步」，拉取当前账号**作为评审人**的 OPEN PR；Draft PR 是否纳入列表由「包含 Draft PR」开关控制（Draft 可阅读评审，但禁止发布状态性动作）。

所需权限：`account`（读身份）、`repository`（读 PR 与 diff）、`pullrequest:write`（发布评论与评审状态）。

## 关键规则（对应需求）

- 评审动作必须由人工从 Approve / Request changes / 仅评论中明确选择，系统不预选；AI 建议仅作参考。
- 发布前展示与实际发送完全一致的英文全文（含署名）；署名与正文分开存储，重复预览与重试不会叠加署名。
- 先发评论与总结，全部成功后才更新远端评审状态；部分失败标记为 partial 并保留逐项回执，可安全重试。
- 模型在轮次创建时冻结：之后修改全局默认模型不影响进行中的轮次与历史署名。
- 校验不通过（范围覆盖不全、发现落在 Team Seal 范围外、缺行号或证据、验收标准未覆盖等）本轮判失败，不会降级成「通过」。
- 跨轮跟踪只会自动判定「仍存在」；本轮未再提及一律记为「无法确认」，必须由你显式改判为已修复。
- 关联需求可人工补充/移除 Jira key，并始终显示每个 issue 的识别来源；系统不会从多个 issue 中替你任选其一。

## 本地 Git 缓存

被评审仓库只读缓存在 `data/repo-cache/<repo>.git`（裸仓库）：

- 绝不初始化或修改你的开发目录，不切分支、不写回远端；
- remote 地址不含 Token，凭据通过 askpass 辅助脚本经环境变量传递；
- 演示模式不拉取真实仓库，界面会明确说明「缓存不可用」而不是假装已取到代码；
- 缓存不可用只是警告，评审仍可基于 PR diff 进行；
- 清理前先展示目录与占用，确认后才删除。

## 键盘快捷键

| 键 | 作用 |
| --- | --- |
| `1` / `2` / `3` | 切换 PR 评审 / 评审历史 / 连接设置 |
| `r` | 手动刷新 PR 列表（不会自动发起 AI 评审） |
| `/` | 聚焦搜索框 |
| `Esc` | 关闭发布预览 |

窄屏（<1280px）下工作区提供「代码差异 / 评审报告」阅读区切换；点击发现会自动跳回差异并定位行。

## 扩展新功能区

`web/js/modules.js` 是模块注册入口，新增功能区只需注册一次，导航、路由与标题自动生效：

```js
registerModule({ id: 'my-tool', name: '我的工具', icon: '✿', route: '#/my-tool', render: renderMyTool });
```

## 尚待确认的外部行为

以下取决于真实环境，代码中已就地标注，live 模式下会明确失败而不是猜测：

- Copilot CLI 的事件输出格式与模型列表获取方式；
- Bitbucket 的 Draft / OPEN / REVIEWING 查询等价映射、行级评论锚点语义、评审状态切换 API 行为；
- Jira 实例类型（Cloud / Data Center）与验收标准字段 ID（必须在设置中显式配置）；
- Team Seal 范围声明的真实样例格式。

## 目录结构

```
server/   HTTP 服务、领域逻辑、集成适配器、服务层与路由
  lib/          错误分类、脱敏日志、ID、HTTP 路由
  security/     本地守卫与凭据存储
  db/           迁移、连接与仓储
  domain/       Team Seal 范围、Jira 核对、署名、AI 结果校验、diff、提示词
  integrations/ bitbucket / jira / copilot 的 mock 与 live 适配器
  services/     settings / connection / pr / review / publish
web/      无构建前端（原生 ESM 模块 + 单一样式表）
tests/    端到端回归
preview/  早期静态原型，仅供参考
```
