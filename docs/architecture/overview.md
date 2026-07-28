# 架构总览

`notion-like-web` 是一个本地优先的 Web 笔记应用：React + Tiptap 单页应用，IndexedDB 持久化，无账号、无云同步、无多人协作。面向简体中文个人用户。

## 技术栈

- React 19 + Vite + TypeScript：单页 Web 应用。
- Tiptap 3：富文本编辑内核，只使用开源扩展，不依赖 Tiptap Pro。
- IndexedDB（idb）：本地数据与二进制资源持久化，DB 当前版本 v3。
- CSS variables + Cascade Layers：语义设计令牌与组件样式（R002）。
- Vitest + Testing Library：单元与组件测试；Playwright：端到端与截图回归。

## 分层

```text
React Components（src/components/）
        ↓ 窄 hook（useWorkspaceSession / useNavigation / usePreferences / useOverlay）
State（src/state/：AppServicesProvider + AppProviders 组合四状态域 Provider；legacy/useApp 仅供测试）
        ↓ AppServices 容器接口
Application（src/application/：保存协调器、会话加载、搜索索引、偏好写入、诊断）
        ↓ domain port
Domain（src/domain/：实体、页面树、搜索、校验、错误码、仓储接口）
        ↑ 实现 port
Infrastructure（src/infrastructure/：IndexedDB、AI HTTP、内存仓储、浏览器 API）
```

依赖方向只能向下（infrastructure 实现 domain 的 port，是被注入方）。规则全文与强制方式见 [dependency-rules.md](./dependency-rules.md)。

## 数据模型

| 实体 | 必要字段 | 说明 |
| --- | --- | --- |
| `Workspace` | `id`, `name`, `icon`, `description`, `homePageId`, `favoriteAt`, `lastOpenedAt`, `createdAt`, `updatedAt` | 知识库根对象 |
| `Page` | `id`, `workspaceId`, `parentId`, `kind`, `title`, `icon`, `position`, `favoriteAt`, `lastOpenedAt`, `deletedAt`, `createdAt`, `updatedAt` | `kind` 为 document 或 group；`deletedAt` 软删 |
| `DocumentContent` | `pageId`, `contentJson`, `textSnapshot`, `updatedAt` | Tiptap JSON（唯一编辑真相）与搜索文本快照 |
| `DocumentRevision` | `id`, `pageId`, `contentJson`, `textSnapshot`, `createdAt`, `reason` | 本地版本（interval / before-restore / manual） |
| `Attachment` | `id`, `pageId`, `name`, `mimeType`, `size`, `blob`, `createdAt` | 附件 Blob，文档节点只存 ID |
| `Tag` | `id`, `workspaceId`, `name`, `color` | 工作区标签定义 |
| `PageTag` | `pageId`, `tagId` | 页面与标签的关联（复合主键） |
| `Preferences` | `id`, `theme`, `sidebarWidth`, `aiConfig`, `lastRoute` | 浏览器本地偏好（单例记录） |
| `TrashRecord` | `pageId`, `deletedAt`, `originalParentId` | 恢复原始位置用 |

索引（DB v3）：pages（`workspaceId`、`parentId`、`deletedAt`、`updatedAt`、复合 `workspaceId_parentId` / `workspaceId_updatedAt`）、contents（`updatedAt`、`textSnapshot`）、tags（`workspaceId`）、pageTags（`pageId`、`tagId`）、revisions（`pageId`、`pageId_createdAt`）、attachments（`pageId`）、trash（`deletedAt`）。详见 [persistence.md](./persistence.md)。

## 编辑器组合

- 文档 schema 唯一定义处：`src/editor/extensions.ts` 的 `buildDocumentExtensions()`（主编辑器与 Markdown 转换器共用）——StarterKit（标题 1–6、链接）、自定义代码块（lowlight 离线高亮 + 语言选择 + 复制）、TextStyleKit、Highlight、TextAlign、Typography、Image、Subscript/Superscript、TaskList/TaskItem、TableKit、Mathematics、自定义 Indent、附件节点。
- 交互层 `buildEditorExtensions()` 叠加：Placeholder、Mention（`getMentionPages` 动态候选）、`/` 命令建议。
- TableOfContents、UniqueID、DragHandle 为 Pro 能力**未使用**：目录（`toc.ts`）、块把手（`BlockHandle`）为自实现。
- 统一命令注册表（`commands.ts`）驱动 `/` 菜单；常驻工具栏经 `format.ts` 共用同一执行函数；AI 命令经 `aiBridge` 事件桥打开面板。
- 保存管线见 [editor-save-pipeline.md](./editor-save-pipeline.md)。

## AI 接口

```ts
type AIMode = "ask" | "polish" | "rewrite" | "summarize" | "draft";

interface AIProvider {
  complete(request: AIRequest): Promise<string>;
}
```

`createOpenAICompatibleProvider` 向用户配置的 endpoint 发 `chat/completions` 请求（30s 超时，HTTP 状态码映射为中文错误）。配置先经 `validateAIConfig` 校验；AI 输出先预览，用户确认后经编辑器白名单解析再写入。API Key 只存 IndexedDB，不进入日志与上报。

## 安全与隐私

- 所有数据只保存在浏览器 IndexedDB / localStorage（恢复缓冲、损坏诊断），不上传、不同步。
- 未配置 AI 时不发起任何外部请求；配置后仅向用户填写的 Endpoint 发送请求。
- 图片、Markdown 导入和 AI 返回内容都经编辑器白名单解析，不向 DOM 注入原始 HTML。
- 开发诊断只记录指标名、毫秒数与计数，不记录文档正文与密钥（见 [error-handling.md](./error-handling.md)）。
