/**
 * R007 阶段 1（DSK-03）：文档版本推进通道。
 *
 * 元数据写入（标题/标签，经 note.patchMetadata）绕过正文保存管线直接
 * 落盘，会使已打开文档的 SaveCoordinator.knownVersion 变陈旧——下一次
 * 正文 autosave 拿旧令牌产生「假冲突」。本通道让元数据写入方把新
 * versionToken 推给当前打开的文档会话：
 *
 *   metadata saved → publish(pageId, newVersion)
 *   → DocumentEditor 订阅 → coordinator.setLoadedVersion(newVersion)
 *
 * 协调器惰性创建（首次编辑才实例化）的场景经 latest() 取最近发布值作
 * 乐观锁起点，覆盖「先改名、后编辑」的时序。
 *
 * 进程内单窗口语义：实现为内存 pub/sub，双端装配同一实现；
 * 跨标签页同步仍由 ChangeChannel 承担（Web 元数据写走同一事务，不需要
 * 本通道）。
 */
import type { ContentVersionToken } from "../../domain/types";

export interface DocumentVersionChannel {
  /** 发布某页面的最新磁盘版本令牌（元数据写入成功后调用）。 */
  publish(pageId: string, version: ContentVersionToken): void;
  /** 订阅某页面的版本推进；返回取消订阅函数。 */
  subscribe(
    pageId: string,
    listener: (version: ContentVersionToken) => void,
  ): () => void;
  /** 该页面最近一次发布的版本；从未发布为 null。 */
  latest(pageId: string): ContentVersionToken | null;
}

/** 内存实现：会话内有效，无持久化、无跨进程语义。 */
export function createInMemoryDocumentVersionChannel(): DocumentVersionChannel {
  const listeners = new Map<
    string,
    Set<(version: ContentVersionToken) => void>
  >();
  const latestByPage = new Map<string, ContentVersionToken>();
  return {
    publish(pageId, version) {
      latestByPage.set(pageId, version);
      for (const listener of listeners.get(pageId) ?? []) listener(version);
    },
    subscribe(pageId, listener) {
      let set = listeners.get(pageId);
      if (!set) {
        set = new Set();
        listeners.set(pageId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(pageId);
      };
    },
    latest(pageId) {
      return latestByPage.get(pageId) ?? null;
    },
  };
}
