# 技术架构与实现细节

## 技术选择

- React + Vite + TypeScript：单页 Web 应用与快速开发环境。
- Tiptap 3：富文本编辑内核；使用开源扩展实现编辑器能力。
- IndexedDB：本地数据与二进制资源的持久化；封装为仓储层，避免 UI 直接访问数据库。
- CSS variables + 模块化样式：主题令牌与高还原的组件样式。
- Vitest + Testing Library：逻辑与组件测试；Playwright：端到端和截图回归。

## 前端分层

```text
app shell
├── workspace / sidebar / tree / search / trash / settings
├── document feature
│   ├── title, tags, import-export, backlinks placeholder
│   └── editor adapter
├── editor feature
│   ├── Tiptap extension bundle
│   ├── slash menu, bubble menu, drag handle, table controls
│   └── AI commands
├── domain stores
│   ├── workspace/page/tag/preferences state
│   └── repository interfaces
└── infrastructure
    ├── IndexedDB repositories
    ├── Markdown conversion
    └── OpenAI-compatible AI provider
```

界面只依赖仓储接口和领域状态；Tiptap 仅通过编辑器适配层与页面内容交互。这样云同步或协作后续可替换基础设施层而不重写界面。

## 数据模型

| 实体 | 必要字段 | 说明 |
| --- | --- | --- |
| `Workspace` | `id`, `name`, `createdAt`, `updatedAt` | 知识库根对象 |
| `Page` | `id`, `workspaceId`, `parentId`, `kind`, `title`, `icon`, `position`, `deletedAt` | `kind` 为 document 或 folder |
| `DocumentContent` | `pageId`, `contentJson`, `textSnapshot`, `updatedAt` | Tiptap JSON 与搜索文本快照 |
| `Tag` | `id`, `workspaceId`, `name`, `color` | 工作区标签定义 |
| `PageTag` | `pageId`, `tagId` | 页面与标签的关联 |
| `Preferences` | `theme`, `sidebarWidth`, `aiConfig` | 浏览器本地偏好 |
| `TrashRecord` | `pageId`, `deletedAt`, `originalParentId` | 用于恢复原始位置 |

IndexedDB 需对 `workspaceId`、`parentId`、`deletedAt`、`updatedAt` 和 `textSnapshot` 建立适用索引。内容 JSON 是唯一编辑真相；`textSnapshot` 只用于搜索与 Markdown 导出辅助。

## 编辑器组合

- 基础：StarterKit、Typography、TextStyle、Color、Highlight、TextAlign、HorizontalRule、Image、Link、Subscript、Superscript、Mathematics。
- 块：TaskList、BulletList、OrderedList、Table、TableOfContents、UniqueID。
- 交互：Suggestion 用于 `/` 与 `@`，BubbleMenu 用于文本工具栏，DragHandle 用于块拖动，Floating UI 用于菜单定位。
- UI 行为：统一命令定义驱动命令菜单、工具栏和块菜单，避免三处功能分叉。
- 保存：编辑器变更经防抖后触发 `onSave(contentJson, textSnapshot)`；文档切换或页面卸载时强制落盘。

## AI 接口

```ts
type AIRequest = {
  prompt: string;
  selection?: string;
  documentContext?: string;
};

interface AIProvider {
  complete(request: AIRequest): Promise<string>;
}
```

`OpenAICompatibleProvider` 向用户配置的 endpoint 发起请求，负责鉴权、请求格式、超时和可读错误转换。调用前由设置状态校验 endpoint、模型和 key 均已提供；AI 输出先展示为可确认的预览，再由用户选择插入或替换。

## 安全与隐私

- API key 和 endpoint 只存 IndexedDB，不进入同步、分析或错误上报。
- 图片、Markdown 导入和 AI 返回内容都要经编辑器白名单解析，不将原始 HTML 直接注入 DOM。
- 外部 AI 只接收用户明确触发时所需的选区和上下文；首次调用在设置页说明数据会发送给用户选择的服务商。
