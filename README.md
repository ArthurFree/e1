# Notion-like Web

一个独立的 Web 笔记应用：以 Tiptap 的 Notion-like 模板为交互和视觉参考，提供本地优先（离线可用）的知识库、页面树和块编辑能力。面向简体中文个人用户。

**当前状态：第 1–5 阶段已全部完成。**

## 功能

- 知识库与页面树：多知识库、树形页面（拖放排序/移动）、重命名、图标
- 块编辑器：`/` 命令菜单、浮动工具栏、块把手（拖拽移动/复制/删除/转换/清除格式）、表格工具条、目录、Emoji、公式、@ 提及
- 笔记管理：标签（添加/筛选）、全局搜索（标题 + 正文）、回收站（恢复/彻底删除/清空）、Markdown 导入导出
- AI 助手（可选）：`/` 命令「AI 助手」提问，选区润色/改写/总结；结果先预览，确认后才写入文档
- 浅色/深色主题，偏好本地持久化

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
npm run test:e2e         # Playwright 端到端 + 1440×900 截图回归 + 响应式冒烟
npm run test:e2e:update  # 更新截图基线（界面变更后执行并审查 diff）
```

Playwright 浏览器二进制安装在项目内（`PLAYWRIGHT_BROWSERS_PATH=0`），首次运行 `test:e2e` 前如缺浏览器，执行 `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`。

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
