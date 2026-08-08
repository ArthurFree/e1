# ADR 006：Markdown 作为 Desktop 持久化真相

## 背景

ADR 002 确立「文档内容 JSON 是唯一编辑真相」，Web 端正文以 Tiptap JSON 存 IndexedDB。R005 引入 Desktop 运行时后需要回答：桌面端的持久化真相是什么？候选方案有：桌面端也存 JSON（与 Web 物理一致）、存 Markdown 文件、或双写。同时当前 Markdown 能力只是导入导出工具，不足以充当持久化格式（不处理 Frontmatter、稳定 ID、附件路径，`localImage` 导出时被丢弃）。

## 决策

- **Desktop 以 Markdown 文件为唯一持久化真相**（DUAL-04）：正文即 Vault 目录下的 `.md` 文件，页面树即文件夹结构，笔记稳定 ID 与标签存 Frontmatter，图片附件为 `assets/` 真实文件；
- **Web 仍以 Tiptap JSON 为编辑真相与真实数据源**（DUAL-03）：IndexedDB 存储不变，两运行时共享应用模型与用例编排，但**不强求物理存储一致**；
- **SQLite 只保存可重建派生索引**（DUAL-05），删除后必须能从 Markdown 全量重建（DUAL-08）；
- 两运行时之间的迁移通道是 Portable Vault（DUAL-09），Web 导出物可直接被 Desktop 打开，Desktop 不依赖 IndexedDB schema；格式定义见 `docs/architecture/portable-vault.md`；
- Markdown 成为持久化格式的前提是阶段 4 把它升级为持久化级 MarkdownCodec（Frontmatter 往返、资源序列化、有损不静默）；节点级策略见 `docs/architecture/markdown-compatibility.md`。

## 原因

- Markdown 文件可被 VS Code 等普通软件直接读取编辑，用户数据不被应用锁定，符合本地优先定位；
- 文件系统天然提供目录树与外部工具互操作，SQLite/索引均为可重建派生物，避免第二份真相引入一致性问题；
- Web 侧 JSON 存储已经过 R003/R004 多轮一致性加固，不要求两端物理一致可以避免对 Web 存储的推倒重来；
- 共享应用模型（命令/查询/保存协调）使存储差异被 port 层吸收，UI 与业务编排只有一份实现。

## 结果

- 阶段 4（MarkdownCodec）、阶段 7（Portable Vault）、阶段 9/10（Desktop 运行时）按此决策实施；
- 新增可持久化编辑器节点必须同时定义 Markdown 迁移策略（DUAL-07），否则不得合入；
- 被否决的替代方案：桌面端也存 Tiptap JSON（失去普通软件可读性与文件系统互操作）、双写 JSON + Markdown（两份真相，一致性成本高于收益）。
