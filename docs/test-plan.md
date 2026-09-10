# 测试与验收计划

## 单元测试

- 页面树：创建、移动、排序、循环父级拦截、删除与恢复原位置。
- 仓储：首次初始化、保存、读取、IndexedDB schema 迁移与损坏数据降级。
- 搜索：标题和正文匹配、回收站内容排除、结果排序。
- Markdown：标题、列表、任务、代码、链接和表格的导入导出。
- AI：缺少配置时的禁用逻辑、请求参数构造、超时与服务端错误映射。

## 组件与交互测试

- 菜单可由鼠标和键盘操作；Escape 正确关闭浮层。
- 文本格式化、任务勾选、块复制/删除/转换与撤销重做正确更新 JSON。
- 表格行列及单元格操作生成有效文档结构。
- 自动保存经过防抖执行，文档切换时无未保存编辑。
- 刷新后的工作区、页面、标签、主题和内容均可恢复。

## 端到端与视觉回归

- 以 1440 × 900 固定视口测试欢迎文档、深色主题、搜索、命令菜单、浮动工具栏、块菜单、表格菜单和回收站。
- 为每个稳定状态保存中文截图基线；比较布局区域、颜色与像素差，并对动态光标、时间和随机 ID 做屏蔽。
- 在 1024px、768px 和 375px 额外运行可用性冒烟测试，检查侧栏、编辑区和浮层不溢出。

## Vault 可移植性（R014 / R014.1）

- 语义冻结与引擎单测：`shared/vaultTransfer/`、`electron/main/vaultTransfer/`（Missing Relocate、同卷 rename-intent、EXDEV copy-verify-delete、跨库 Copy/Move、边界/身份/revision blocker、Destination Snapshot stale、100 篇预检）。
- 引用式链接：`scanMarkdownLinkDestinations` / `rewriteMarkdownLinkDestinations` / `extractMarkdownLinks`。
- 桌面 Golden：`e2e/desktop.vaultTransfer.spec.ts` G57–G71 与 G69b–d / G71b–g（描述前缀「桌面冒烟」）。
- 安装包：`e2e/package/desktop.package.vaultTransfer.spec.ts` P27–P30 与 P30b–d（无产物 skip；真实跑过安装包才算 R014 DoD）。

## 知识图谱（R015）

- 投影单测：`src/application/graph/GraphProjectionService.test.ts`（stable id 节点、broken 不虚构节点、orphan、截断）。
- UI：文档页 Local Graph（`services.graph` 门控）；知识库首页「知识图谱」有界 Workspace Graph。

## macOS 分发信任（R013）

- 策略单测：`scripts/macTrustPolicy.test.mjs`（预检 yes/no、codesign 解析、entitlement 白名单、本地/Release builder 分流）。
- 真机脚本：`verify:mac-signing` / `verify:mac-entitlements` / `verify:mac-distribution`（正式 Release 强制；本地 unsigned skip）。
- 安装包 E2E：P01–P20 在 signed 产物上回归；P21–P24 锁定身份/运行时/公证/safeStorage；P25–P26 在无更新 feed 时断言 `canAutoInstall` 与重启保持。

## 发布前验收

- 新浏览器配置下不联网即可创建并保存笔记。
- 未配置 AI 时不出现外部 API 请求；配置后调用目标 endpoint 且结果只能在用户确认后写入文档。
- 所有自动化测试、类型检查和生产构建通过。
- 手动检查键盘导航、焦点、对比度和导入失败信息。
