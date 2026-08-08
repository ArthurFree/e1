# R005 执行版：Web 优先与双运行时目标架构

本文是 `docs/requirements/r005.md` 的执行参考版：只保留目标架构、数据归属、阶段路线与最终验收清单，作为各批次实施与验收时的对照文档。背景评估与详细设计论证以 r005.md 为准。

## 核心策略

```text
Web 继续作为唯一正式交付端
+
所有新底层能力按双运行时设计
+
完成架构准备后再做 Electron 技术验证
```

阶段 9 之前：不加入 SQLite，不引入文件监听，不投入安装器、签名和自动更新。

## 目标架构分层

```text
┌──────────────────────────────────────┐
│ Shared UI                            │
│ React / Tiptap / Components / State  │
└─────────────────┬────────────────────┘
                  │ Commands / Queries
┌─────────────────▼────────────────────┐
│ Shared Application                  │
│ WorkspaceCommands                   │
│ DocumentCommands                    │
│ SearchPort                          │
│ AssetPort                           │
│ RecoveryPort                        │
│ SaveCoordinator                     │
│ MarkdownCodec                       │
└─────────────┬─────────────┬──────────┘
              │             │
      ┌───────▼──────┐ ┌────▼─────────────┐
      │ Web Runtime  │ │ Desktop Runtime   │
      │ IndexedDB    │ │ IPC Client        │
      │ localStorage │ │                   │
      │ Browser APIs │ └────────┬──────────┘
      └──────────────┘          │ IPC
                         ┌───────▼──────────┐
                         │ Electron Main    │
                         │ Node fs          │
                         │ Markdown Files   │
                         │ SQLite Index     │
                         │ File Watcher     │
                         └──────────────────┘
```

UI 和状态层只调用应用命令，不知道最终使用 IndexedDB 还是 Markdown 文件。各层职责与禁止事项见 `docs/architecture/runtime-boundaries.md`。

## 数据存储归属

| 数据           | Web 正式版              | Electron 正式版              |   是否迁移 |
| -------------- | ----------------------- | ---------------------------- | ---------: |
| 笔记正文       | IndexedDB Tiptap JSON   | 本地 Markdown                |         是 |
| 笔记 ID        | IndexedDB Page ID       | Frontmatter ID               |         是 |
| 页面树         | Page 表                 | 文件夹和 Markdown 路径       |         是 |
| 标签           | Tag/PageTag 表          | Frontmatter                  |         是 |
| 图片和附件     | IndexedDB Blob          | `assets/` 真实文件           |         是 |
| 搜索索引       | 内存索引                | SQLite FTS                   | 否，可重建 |
| 版本历史       | IndexedDB               | 本机应用数据或 `.e1/history` |       可选 |
| 恢复缓冲       | localStorage            | Electron userData            |         否 |
| 主题和窗口状态 | IndexedDB               | Electron userData            |         否 |
| AI 密钥        | SecretStore 的 Web 实现 | 系统安全存储                 |         否 |
| 最近访问       | IndexedDB               | 本机应用数据库               | 通常不迁移 |

Web 继续以 Tiptap JSON 为唯一编辑真相；Electron 以后以 Markdown 文件为唯一持久化真相。两个运行时共享应用模型，但不强求物理存储一致。

## 阶段路线

| 阶段 | 内容                              | 关键产出                                                               |
| ---- | --------------------------------- | ---------------------------------------------------------------------- |
| 0    | R005 基线：文档、不变量、能力矩阵 | 六篇文档 + DUAL-01~09 + `RuntimeCapabilities`（本批次）                |
| 1    | 业务编排移出 React Provider       | commands/queries 应用服务；Provider 只管状态生命周期                   |
| 2    | Web Bootstrap 与共享挂载入口拆分  | `mountApplication` + `main.web.tsx`；不装 Electron                     |
| 3    | 版本号改平台无关模型              | `ContentVersionToken` 不透明 token；Web 乐观锁语义不变                 |
| 4    | 持久化级 MarkdownCodec            | Frontmatter/链接/图片附件序列化/有损保护；导出不再丢图片               |
| 5    | 附件与资源访问抽象                | AssetMetadata/AssetAccessService；application/domain 不暴露 Blob       |
| 6    | 搜索抽象 + 会话解除全正文依赖     | `SearchIndexPort`；WorkspaceSessionData 不再携带全部正文               |
| 7    | Web Portable Vault 导入导出       | 完整备份与迁移通道（格式定义见 `docs/architecture/portable-vault.md`） |
| 8    | 其余平台服务抽象                  | RecoveryStore/SettingsStore/SecretStore/ChangeChannel/StorageHealth    |
| 9    | Electron 技术验证版               | 复用 React Renderer + 本地 Vault 目录 + Markdown 原子写回              |
| 10   | Electron 正式数据层               | SQLite 派生索引、文件监听、桌面回收站/排序/版本历史                    |

## 阶段优先级

- **立即执行**：阶段 0（R005 文档与不变量）、阶段 1（业务编排移出 Provider）、阶段 2（Bootstrap 拆分）、阶段 4（MarkdownCodec）——直接改善 Web 架构和导入导出质量。
- **第二批**：阶段 3（VersionToken）、阶段 5（Asset 抽象）、阶段 6（SearchPort）、阶段 7（Portable Vault）——完成后具备较完整的桌面数据迁移基础。
- **第三批**：阶段 8（平台服务抽象）、阶段 9（Electron 技术验证）。
- **暂缓**：阶段 10（SQLite、文件监听和桌面产品化）——必须等技术验证和用户需求确认后再投入。

## 进入 Electron 技术验证的启动条件（阶段 1~8 全部满足）

```text
[ ] React Provider 不直接访问仓储
[ ] Web/Desktop Bootstrap 已分离
[ ] version 已变成不透明 token
[ ] MarkdownCodec 支持 Frontmatter 和资源
[ ] 附件接口不依赖 Blob
[ ] 搜索已抽象为 Port
[ ] Portable Vault 导入导出可用
[ ] Recovery/Settings/Sync 已平台化
```

## 最终完成标准（进入阶段 9 前必须全部满足）

```text
[ ] Web 仍然是稳定正式版本
[ ] UI 和 Provider 不访问原始仓储
[ ] 应用服务不知道 IndexedDB 或 Electron
[ ] Web/Desktop 有独立 Bootstrap
[ ] 所有平台差异使用 Capability
[ ] SaveCoordinator 使用不透明版本 token
[ ] Markdown 支持 Frontmatter
[ ] Markdown 导出包含图片和附件
[ ] 未支持语法不会静默丢失
[ ] 附件领域模型不包含 Blob
[ ] 搜索使用 SearchIndexPort
[ ] WorkspaceSession 不读取全部正文构建搜索
[ ] Recovery/Settings/Secret/ChangeChannel 已抽象
[ ] Web 可以导出完整 Portable Vault
[ ] Portable Vault 可以重新导入 Web
[ ] 所有平台 Port 有契约测试
[ ] npm run ci 和 Web E2E 全部通过
```
