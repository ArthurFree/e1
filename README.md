# Notion-like Web

一个独立的 Web 笔记应用：以 Tiptap 的 Notion-like 模板为交互和视觉参考，提供本地优先（离线可用）的知识库、页面树和块编辑能力。面向简体中文个人用户。

**当前状态：R003 与 R004 架构整改全部完成——保存协调器（串行 + 代次 + 恢复缓冲 + 乐观锁）、统一文档写入边界（原子创建 + 提交单点）、四状态域 Provider、IndexedDB v5（secrets store）、图片附件化与存储配额治理、多标签页同步与冲突处理、ESLint/Prettier/dependency-cruiser 与 GitHub Actions 工程门禁。R005（Web 优先与 Electron 双端准备）阶段 0–8 已完成——命令/查询服务下沉与 AppServices 收紧、不透明 `ContentVersionToken` 乐观锁、持久化级 MarkdownCodec、Asset 服务抽象（AssetStore + `Uint8Array`）、`SearchIndexPort` 与会话去正文、Portable Vault（.e1.zip）导入导出、RecoveryStore / ChangeChannel / SecretStore / StorageHealthService。R006 Electron Desktop 技术验证版阶段 0–C4 已完成（Shell、IPC 契约、Vault 扫描、安全阅读、Markdown 创建与安全保存）；C4.1 写入链路加固与身份一致性收口已完成；C5（本地附件）待开始。**

## 功能

- 组织：多知识库（图标/描述/收藏）、全局「开始」首页（快速创建 + 编辑过/浏览过活动区）、知识库首页（统计 + 目录概览）、分组（任意层级、拖放排序）、跨知识库最近与收藏
- 块编辑器：`/` 命令菜单、常驻格式工具栏（标题 1–6、字号、缩进、对齐、插入）、浮动工具栏、块把手、表格工具条、目录、Emoji、公式、@ 提及
- 技术文档：代码块语言选择与离线语法高亮、复制；附件块（20MB 上限，离线可下载）
- 笔记管理：标签、全局搜索、回收站、Markdown 导入导出、知识库整体备份/迁移（.e1.zip Portable Vault 导入导出，含图片附件）、六个内置模板、AI 新建文档
- 写作保障：保存状态（未保存/保存中/已保存/失败重试）、字数统计、本地版本历史（自动间隔版本、恢复前自动存档）
- AI 助手（可选）：`/` 命令提问，选区润色/改写/总结；结果先预览，确认后才写入文档
- 浅色/深色主题，偏好与路由本地持久化

## 运行

```bash
npm install
npm run dev          # 开发（默认 http://localhost:5173）
npm run build        # 类型检查 + 生产构建（输出 dist/）
npm run preview      # 预览生产构建
```

## 测试

```bash
npm test                 # 单元与组件测试（Vitest + Testing Library）
npm run typecheck        # TypeScript 检查
npm run lint             # ESLint（flat config，0 error 门禁）
npm run format:check     # Prettier 格式检查
npm run deps:check       # dependency-cruiser 分层与循环依赖检查
npm run test:coverage    # 覆盖率（@vitest/coverage-v8）
npm run ci               # 统一门禁：typecheck + lint + deps:check + test + build
npm run test:e2e         # Playwright 端到端 + 1440×900 截图回归 + 响应式冒烟
npm run test:e2e:update  # 更新截图基线（界面变更后执行并审查 diff）
```

Desktop（R006 技术验证版，Electron）：

```bash
npm run dev:desktop      # 桌面开发（vite dev + esbuild watch + Electron 窗口）
npm run build:desktop    # Web 构建 + Electron 主进程/预加载打包（dist-electron/）
npm run test:desktop     # 桌面侧单元测试（IPC 契约/preload/平台适配）
npm run test:e2e:desktop # Electron 冒烟（需先 build:desktop，不进 CI）
```

Playwright 浏览器二进制安装在项目内（`PLAYWRIGHT_BROWSERS_PATH=0`），首次运行 `test:e2e` 前如缺浏览器，执行 `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`。

CI（`.github/workflows/ci.yml`）：quality job 跑 `npm run ci` + 覆盖率；e2e job 跑功能与响应式（视觉截图基线为 macOS 生成，不纳入 CI，基线变化须人工审查）。

## 架构

### 技术栈

- React 19 + Vite + TypeScript：单页 Web 应用
- Tiptap 3：富文本编辑内核，仅使用开源扩展，不依赖 Tiptap Pro
- IndexedDB（idb）：本地持久化，经仓储层封装，UI 不直接访问数据库
- 自有 UI 系统（R002）：语义设计令牌（`tokens.css`，浅/深双主题，主色 `#22A06B`）、240px 全局侧栏、统一 Dialog/EmptyState/Button/IconButton、Lucide 风格 SVG 图标、Cascade Layers 样式分层
- Vitest + Testing Library：单元与组件测试；Playwright：端到端与截图回归

### 前端分层

```text
src/
├── components/          # 应用壳：全局侧栏、页面树侧栏、搜索/回收站/设置面板、主栏
│   └── editor/          # 编辑器 UI：常驻/浮动工具栏、块把手、表格工具条、AI 面板、目录
├── editor/              # 编辑器内核：扩展组合、统一命令注册表、/@ 浮层、
│                        #   块操作、表格工具、Markdown 转换、AI 事件桥
├── state/               # AppServicesProvider + 四状态域 Context
│                        #   （WorkspaceSession/Navigation/Preferences/Overlay）+ useApp 兼容门面
├── application/         # 应用服务：保存协调器、会话加载、搜索索引、偏好写入、
│                        #   恢复缓冲、损坏诊断、AppServices 容器接口
├── domain/              # 纯逻辑：实体类型、页面树、搜索、AI、校验与错误码、仓储接口
└── infrastructure/      # IndexedDB 实现（DB v4）、种子数据、OpenAI 兼容 AI provider、
                         #   浏览器服务装配根、内存仓储
```

界面只依赖仓储接口和领域状态，生产代码不直接 import infrastructure：应用能力经 `AppServices` 容器注入（装配根 `browserServices.ts`，测试可换内存仓储）。Tiptap 仅通过编辑器适配层（`DocumentEditor`）与页面内容交互。基础设施层（IndexedDB、Markdown 转换、AI provider）可整体替换而不重写界面。

### 数据模型

| 实体               | 必要字段                                                                                                                                  | 说明                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Workspace`        | `id`, `name`, `icon`, `description`, `homePageId`, `favoriteAt`, `lastOpenedAt`, `createdAt`, `updatedAt`                                 | 知识库根对象                                                              |
| `Page`             | `id`, `workspaceId`, `parentId`, `kind`, `title`, `icon`, `position`, `favoriteAt`, `lastOpenedAt`, `deletedAt`, `createdAt`, `updatedAt` | `kind` 为 document 或 group；`deletedAt` 软删                             |
| `DocumentContent`  | `pageId`, `workspaceId`, `contentJson`, `textSnapshot`, `updatedAt`, `version`                                                            | Tiptap JSON 与搜索文本快照；version 为不透明 `ContentVersionToken` 乐观锁 |
| `DocumentRevision` | `id`, `pageId`, `contentJson`, `textSnapshot`, `createdAt`, `reason`                                                                      | 本地版本（interval / before-restore / manual）                            |
| `Attachment`       | `id`, `pageId`, `name`, `mimeType`, `size`, `createdAt`                                                                                   | 附件元数据；二进制经 `AssetStore` 以 `Uint8Array` 读写，文档节点只存 ID   |
| `Tag`              | `id`, `workspaceId`, `name`, `color`                                                                                                      | 工作区标签定义                                                            |
| `PageTag`          | `pageId`, `tagId`, `workspaceId`                                                                                                          | 页面与标签的关联                                                          |
| `Preferences`      | `theme`, `sidebarWidth`, `aiConfig`                                                                                                       | 浏览器本地偏好                                                            |
| `TrashRecord`      | `pageId`, `deletedAt`, `originalParentId`                                                                                                 | 用于恢复原始位置                                                          |

文档内容 JSON 是唯一编辑真相（读入前经白名单运行时校验）；`textSnapshot` 仅用于搜索与 Markdown 导出。仓储读取含损坏数据降级（字段缺失/形状不符时跳过或回退默认值）。数据库当前版本 v4，迁移按 oldVersion 分支在 upgrade 事务内完成（v1→v2 将 `folder` 原地改写为 `group` 并补齐新字段；v2→v3 新增复合索引；v3→v4 为 contents/pageTags 回写 workspaceId 并新增工作区索引）；搜索经 `SearchIndexPort`（Web 实现为工作区级内存索引 `BrowserMemorySearchIndex`）：会话加载不再携带全部正文，索引经 `prepareWorkspace` 自行按工作区索引读取页面与正文快照；正文写入经 `DocumentCommitService` 单点完成落盘 + 索引同步，保存携带 expectedVersion（不透明 `ContentVersionToken`，`idb:N` 编码）乐观锁。

### 编辑器组合

- 基础：StarterKit（标题 1–6、链接）、TextStyleKit、Highlight、TextAlign、Typography、Subscript/Superscript、Mathematics
- 块：TaskList、BulletList、OrderedList、Table、代码块（lowlight 离线高亮 + 语言属性）、附件节点、localImage 图片节点（只存 attachmentId，二进制经 AssetStore 以 `Uint8Array` 存取；旧 Base64 图片兼容读取但不再新增）
- 交互：Suggestion 驱动 `/` 与 `@` 浮层（@ 候选经 `getMentionPages` 动态读取），BubbleMenu 驱动文本工具栏，Floating UI 定位；块拖拽把手与目录为自实现（DragHandle/TableOfContents 是 Pro 能力，未使用）
- 统一命令注册表（`src/editor/commands.ts`）驱动 `/` 菜单；常驻工具栏经 `format.ts` 共用同一执行函数，AI 命令经 `aiBridge` 事件桥打开面板，避免功能分叉
- 保存：`DocumentSaveCoordinator` 串行队列 + 代次管理（800ms 防抖、切换文档强制落盘、快照时间边界的附件清理、当前代次专属的自动版本、失败重试、expectedVersion 乐观锁与冲突面板）；localStorage 恢复缓冲兜底未落盘内容，启动时提示恢复；保存成功后按 5 分钟间隔生成自动版本（去重、上限 100 条 + 5MB 字节预算）

### AI 接口

```ts
type AIMode = "ask" | "polish" | "rewrite" | "summarize";

type AIRequest = {
  prompt: string;
  selection?: string; // 选区文字（润色/改写/总结）
  documentContext?: string; // 正文快照片段（ask）
  mode?: AIMode;
};

interface AIProvider {
  complete(request: AIRequest): Promise<string>;
}
```

`createOpenAICompatibleProvider` 向用户配置的 endpoint 发 `chat/completions` 请求（30s 超时，HTTP 状态码映射为中文错误）。配置先经 `validateAIConfig` 校验；AI 输出先预览，用户确认后经编辑器白名单解析再插入或替换。

### 测试体系

- 单元/组件：页面树、仓储（含迁移与降级）、搜索、Markdown、AI 校验与错误映射、面板交互（Vitest + jsdom + fake-indexeddb）
- 端到端：功能流程（含 mock endpoint 验证「AI 结果确认后才写入」）、1440 × 900 截图基线（动态内容 mask）、1024/768/375 响应式冒烟（Playwright）

更完整的架构说明见 [docs/architecture.md](./docs/architecture.md)（索引，拆分后的主题文档在 [docs/architecture/](./docs/architecture/)，重大决策 ADR 在 [docs/adr/](./docs/adr/)）。

## 隐私说明

- 所有数据（页面、内容、标签、偏好、AI 配置）只保存在浏览器 IndexedDB，不上传、不同步。
- AI 为可选项：未配置时不发起任何外部请求；配置后仅向用户填写的 Endpoint 发送 `chat/completions` 请求，API Key 只用于该请求的 Authorization 头，不写入日志。
- AI 返回内容经编辑器白名单解析，且必须经用户确认「应用」后才会写入文档。
- 图片与 Markdown 导入同样经白名单解析，不向 DOM 注入原始 HTML。

## 已确认决策

- 客户端：React、Vite、TypeScript、Tiptap 3（仅开源扩展，无 Pro 能力）
- 存储：IndexedDB，本地离线优先
- 默认语言：简体中文；视觉基准：1440 × 900 桌面视口
- 不在范围：账号、云同步、多人协作、评论、权限、支付

详见 [docs](./docs/)（需求、架构、UI 规范、测试计划、决策记录）。
