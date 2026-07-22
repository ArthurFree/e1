# AGENTS.md

面向 AI 编码代理的项目说明。本文件描述项目当前的真实状态，不推测未实现的细节。

## 项目概述

`notion-like-web` 是一个独立的 Web 笔记应用：以 Tiptap 的 Notion-like 模板为交互和视觉参考，提供本地优先（离线可用）的知识库、页面树和块编辑能力。面向简体中文个人用户。

**当前状态：第 1–5 阶段与 R001（v0.2，语雀式知识库结构与编辑区增强）已全部完成，R001 待验收。** 工程、IndexedDB 仓储、页面树、标题自动保存、主题持久化；编辑器核心（Tiptap 3 开源扩展、`/` 命令、浮动工具栏、Emoji、目录、公式）；高级块交互：自实现块把手、表格工具条、顶栏撤销/重做；笔记管理：页面树拖放、标签、全局搜索、回收站、Markdown 导入导出；AI：设置面板配置 OpenAI 兼容服务、`/` 命令「AI 助手」、选区润色/改写/总结（预览确认后应用，未配置安全降级）。R001 v0.2 增量：全局「开始」首页（快速创建四卡片 + 编辑过/浏览过活动区 + 归属筛选分页）、知识库首页（图标/描述/收藏/统计/目录概览）、文件夹原地迁移为分组（DB v2，含 revisions/attachments store 与 v1 fixture 迁移测试）、跨知识库最近与收藏、六个内置模板、AI 新建文档流程、常驻格式工具栏（段落样式/标题 1–6/字号/缩进/对齐/插入）、代码块语言（lowlight 离线高亮 + 复制）、附件块（20MB 上限、Blob 存储、孤儿清理、永久删除级联）、保存状态机（未保存/保存中/已保存/失败重试）、字数统计（CJK 逐字 + 拉丁连续段）、本地版本历史（5 分钟间隔、去重、自动版本上限 100、恢复前自动存档）。质量：204 项单元/组件测试、33 项 Playwright（功能 14、视觉基线 13 张、响应式冒烟 6）、typecheck、生产构建全部通过。常用命令：`npm run dev`、`npm run build`、`npm test`、`npm run typecheck`、`npm run test:e2e`（截图基线更新用 `npm run test:e2e:update`）。

## 源码结构

- `src/domain/`：实体类型（`types.ts`）、页面树纯逻辑（`pageTree.ts`）、全局搜索（`search.ts`）、AI（`ai.ts`）、活动列表排序与归属路径（`activity.ts`）、创建位置选择（`picker.ts`）、路由持久化（`route.ts`）、版本策略（`revisions.ts`）、字数统计（`wordCount.ts`）、仓储接口（`repositories.ts`）。
- `src/infrastructure/`：IndexedDB 实现——`db.ts`（DB v2 schema 与按 oldVersion 分支迁移，导出 `createV1Schema` 供迁移 fixture）、`repositories.ts`（含损坏数据降级、软删/恢复、版本与附件仓储、purge 级联）、`seed.ts`（预置知识库，模块级 Promise 防并发重复种子）、`aiProvider.ts`、`migration.test.ts`（v1 真实 fixture 迁移测试）。
- `src/editor/`：编辑器内核——`extensions.ts`、`markdown.ts`、`commands.ts`（统一命令注册表）、`aiBridge.ts`、`slashSuggestion.ts` / `mentionSuggestion.ts` / `popupRenderer.ts`、`toc.ts`、`blockActions.ts`、`tableUtils.ts`、`format.ts`（段落样式/字号/清格式，常驻工具栏与其他入口共用）、`indent.ts`、`codeBlock.ts`（语言选择 + lowlight 高亮 + 复制）、`attachment.ts`（附件节点）、`templates.ts`（六个内置模板 JSON）。
- `src/state/AppState.tsx`：应用状态 Provider（视图路由 `view`、页面/标签/回收站/搜索/收藏/最近浏览 action、AI 配置与设置面板开关），UI 只通过它和仓储接口取数。
- `src/components/`：`AppShell`、`WorkspaceRail`（开始/知识库切换/搜索/最近/收藏/回收站/设置 + 开始预览）、`PageTreeSidebar`、`MainArea`（按视图分发）、`StartPage`、`ActivityList`、`RecentPage`、`FavoritesPage`、`WorkspaceHome`、`TargetPicker`、`TemplateCenter`、`AIDraftModal`、`CreateWorkspaceModal`、`SearchPanel`、`TrashPanel`、`SettingsPanel`、`VersionPanel`、`TagPicker`、`TitleEditor`、`StartPreview`；`src/components/editor/`：`DocumentEditor`（宿主 + 保存适配器 + 保存状态机 + 间隔自动版本）、`FormatToolbar`（常驻工具栏）、`BubbleToolbar`、`AIAssistantPanel`、`SaveStateIndicator`、`WordCount`、`TableToolbar`、`BlockHandle`、`CommandList`、`EmojiPicker`、`TocPanel`。
- `src/hooks/useDebouncedCallback.ts`：防抖保存 hook（beforeunload/卸载时 flush）。
- `src/styles/global.css`：主题令牌（`data-theme` 切换浅/深）与全部组件样式、响应式规则；应用壳网格行高固定为 `minmax(0, 1fr)` 且 `overflow: clip`；`.doc-layout` 纵向（工具栏在上），`.doc-main` 为正文 + 目录行容器。
- `e2e/`：Playwright 测试——`app.spec.ts`（14 例功能端到端：开始首页/知识库首页/收藏/最近/保存状态/版本历史/模板/AI/回收站，含 mock endpoint 验证「确认后才写入」）、`visual.spec.ts`（13 张 1440 × 900 基线，存于 `visual.spec.ts-snapshots/`）、`responsive.spec.ts`（1024/768/375 冒烟）；浏览器二进制装在项目内（`PLAYWRIGHT_BROWSERS_PATH=0`，npm script 已注入）。

## 技术栈（已确认的决策）

- React + Vite + TypeScript：单页 Web 应用。
- Tiptap 3：富文本编辑内核，只使用开源扩展，不引入 Tiptap Pro 专有能力；Markdown 导入导出用官方 `@tiptap/markdown`。
- IndexedDB：本地数据与二进制资源持久化，封装为仓储层。
- CSS variables + 模块化样式：主题令牌与组件样式。
- Vitest + Testing Library：单元与组件测试；Playwright：端到端与截图回归。

首版不做：注册/登录、云同步、多人协作、评论、权限、支付。

## 文档结构（唯一的内容来源）

- `README.md`：功能、运行/测试命令、架构概览（分层/数据模型/编辑器组合/AI 接口）、隐私说明与已确认决策。
- `docs/requirements.md`：产品需求、功能范围与验收标准。
- `docs/architecture.md`：前端分层、数据模型、编辑器扩展组合、AI 接口、安全与隐私要求。
- `docs/ui-spec.md`：页面结构、视觉状态、响应式规则与可访问性要求；基准视口 1440 × 900。
- `docs/test-plan.md`：单元、组件、端到端与视觉回归测试计划及发布前验收。
- `docs/implementation-plan.md`：五个实现阶段及各阶段完成标准。
- `docs/decisions.md`：决策记录表；**任何改变这些结论的需求，须先更新本表及受影响的文档，再改代码。**

## 开始实现时的架构约束

- 界面只依赖仓储接口和领域状态；Tiptap 仅通过编辑器适配层与页面内容交互，基础设施层（IndexedDB、Markdown 转换、AI provider）可整体替换。
- 文档内容 JSON 是唯一编辑真相；`textSnapshot` 仅用于搜索与 Markdown 导出。
- 统一命令定义驱动命令菜单、浮动工具栏和块菜单，避免三处功能分叉。
- 编辑器变更经防抖后保存；切换文档或卸载页面时强制落盘。
- 实施顺序约束（见 `docs/implementation-plan.md` 末尾）：仓储与领域模型先于编辑器保存；命令注册先于各类菜单；表格、拖拽、AI 在基础编辑器稳定后引入；每阶段完成后才更新视觉基线。

## 构建与测试

已有命令：`npm run dev`（开发）、`npm run build`（类型检查 + 生产构建）、`npm test`（Vitest，jsdom + fake-indexeddb）、`npm run typecheck`。后续按 `docs/test-plan.md` 补齐：

- 单元测试覆盖页面树、仓储（含 IndexedDB schema 迁移与损坏数据降级）、搜索、Markdown 导入导出、AI 配置校验与错误映射。
- 组件测试覆盖菜单键盘操作、格式化、撤销重做、自动保存防抖、刷新后状态恢复。
- Playwright 在 1440 × 900 固定视口做截图回归，保存中文基线并对动态光标、时间、随机 ID 做屏蔽；另在 1024px、768px、375px 做响应式冒烟。
- 发布前须通过全部自动化测试、类型检查和生产构建。

## 约定与安全要求

- 默认语言为简体中文：UI 文案、预置示例文档、截图基线均使用中文。
- API key 和 endpoint 只存 IndexedDB，不进入同步、日志、分析或错误上报；未配置 AI 时不发起任何外部请求，AI 输出须经用户确认后才写入文档。
- 图片、Markdown 导入和 AI 返回内容都经编辑器白名单解析，禁止把原始 HTML 直接注入 DOM。
- 可访问性：图标按钮提供 `aria-label`，菜单支持方向键、Enter、Escape，保证可见焦点状态与文本对比度。
- 视觉基准为 1440 × 900 桌面视口下的高还原度；窄屏（768px、375px）保持可用即可。
