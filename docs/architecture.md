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

## 决策记录

- 重大架构决策（ADR）：[adr/](./adr/)——001 本地优先、002 文档 JSON 唯一真相、003 SaveCoordinator、004 应用层与服务容器。
- 全部决策汇总表：[decisions.md](./decisions.md)。

## 数据库迁移

- [migrations/indexeddb-v3.md](./migrations/indexeddb-v3.md)：v2 → v3 变更、nullable 索引行为、原子性与回滚。
