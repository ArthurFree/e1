/**
 * R007 阶段 3（DSK-02，r007 §3.3）：外部 Vault 变更服务契约。
 *
 * Main 侧 Watcher 经 events:vaultChanges 推送文件系统事实（哪个相对路径
 * 发生了什么），Renderer 侧实现负责 reconciliation——事件批处理、扫描
 * 快照 diff，对外只发布归一化的文档级变更流（ExternalDocumentChange）。
 *
 * 本文件为 application 层纯契约：不含任何 desktop/IPC/API 依赖；
 * 实现见 platform/desktop/DesktopExternalVaultChangeService，消费方
 * （页面树刷新桥、后续文档层重载策略 r007 §3.4）只依赖本接口。
 * Web/内存容器不装配本服务（AppServices 可选字段），UI 以
 * capabilities.fileWatching 门控（DUAL-01）。
 */

/**
 * 归一化的外部文档变更。pageId 与 vaultMapping.pageIdOfEntry 同口径
 * （document 优先 Frontmatter stable noteId，缺失时 path:<relativePath>）。
 */
export type ExternalDocumentChange =
  | { type: "created"; vaultId: string; pageId: string }
  | { type: "modified"; vaultId: string; pageId: string }
  | { type: "moved"; vaultId: string; pageId: string; from: string; to: string }
  | { type: "deleted"; vaultId: string; pageId: string };

export interface ExternalVaultChangeService {
  /** 开始监听外部变更（重复调用为 no-op）。 */
  start(): void;
  /** 停止监听：取消事件订阅并丢弃未处理的缓冲批次。 */
  stop(): void;
  /** 订阅归一化变更批次（只投递非空批次）；返回取消订阅函数。 */
  subscribe(listener: (changes: ExternalDocumentChange[]) => void): () => void;
}
