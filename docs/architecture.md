# 技术架构文档索引

架构文档已按主题拆分（R003 阶段 8）。本页保留为索引与阅读顺序建议。

## 阅读顺序

1. [architecture/overview.md](./architecture/overview.md)：技术栈、分层、数据模型、编辑器组合、AI 接口、安全与隐私——先看这里。
2. [architecture/dependency-rules.md](./architecture/dependency-rules.md)：分层依赖规则与强制方式（架构约束扫描测试）。
3. [architecture/state-management.md](./architecture/state-management.md)：四状态域 Context、会话原子加载、渲染隔离、偏好写入。
4. [architecture/editor-save-pipeline.md](./architecture/editor-save-pipeline.md)：SaveCoordinator 保存管线、防抖与恢复缓冲。
5. [architecture/persistence.md](./architecture/persistence.md)：DB v3 schema 与索引、迁移策略、仓储横切策略、搜索索引、内存仓储。
6. [architecture/error-handling.md](./architecture/error-handling.md)：DomainError 错误码、正文校验、损坏恢复流程、开发诊断。
7. [architecture/document-write-path.md](./architecture/document-write-path.md)：全部正文写入路径盘点、保存状态机、generation 语义与 R004 一致性不变量。
8. [architecture/runtime-boundaries.md](./architecture/runtime-boundaries.md)：四层运行时边界、DUAL-01~09 架构不变量与 `RuntimeCapabilities` 能力矩阵（R005）。
9. [architecture/portable-vault.md](./architecture/portable-vault.md)：Portable Vault v1 格式定义——ZIP 布局、manifest/vault 字段、转换规则、导入流程与报告（R005，实现在阶段 7）。
10. [architecture/markdown-compatibility.md](./architecture/markdown-compatibility.md)：编辑器节点/mark → Markdown 迁移策略矩阵与有损处理约定（R005，DUAL-07 对照表）。

## 决策记录

- 重大架构决策（ADR）：[adr/](./adr/)——001 本地优先、002 文档 JSON 唯一真相、003 SaveCoordinator、004 应用层与服务容器、005 Web 优先与双运行时、006 Markdown 作为 Desktop 持久化真相。
- 全部决策汇总表：[decisions.md](./decisions.md)。

## 数据库迁移

- [migrations/indexeddb-v3.md](./migrations/indexeddb-v3.md)：v2 → v3 变更、nullable 索引行为、原子性与回滚。
- [migrations/indexeddb-v4.md](./migrations/indexeddb-v4.md)：v3 → v4 工作区字段回写与索引、孤立记录处理、写入路径约束。
