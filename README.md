# Notion-like Web

一个独立的 Web 笔记应用：以 Tiptap 的 Notion-like 模板为交互和视觉参考，提供本地优先的知识库、页面树和块编辑能力。

当前进度：第 1–4 阶段已完成（工程、IndexedDB 仓储、页面树、Tiptap 编辑器核心、`/` 命令、浮动工具栏、块拖拽把手与块菜单、表格操作、页面树拖放、标签、全局搜索、回收站、Markdown 导入导出）。下一是第 5 阶段（AI 设置与 `/ask ai`、端到端与截图回归测试、发布收尾）。

## 运行

```bash
npm install
npm run dev    # 开发
npm test       # 测试
npm run build  # 类型检查 + 生产构建
```

## 已确认决策

- 产品目录：`notion-like-web`
- 客户端：React、Vite、TypeScript、Tiptap
- 首版存储：IndexedDB，本地离线优先
- 默认语言：简体中文
- 视觉基准：1440 × 900 桌面视口
- AI：可配置的 OpenAI-compatible 服务；密钥只保留在浏览器本地
- 不在首版范围：账号、云同步、多人协作、Tiptap Pro 专有能力

详见 [docs](./docs/)。
