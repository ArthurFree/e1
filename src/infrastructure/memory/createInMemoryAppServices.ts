/**
 * 内存服务容器（R003 阶段 5）：AppServices 的纯内存实现。
 * 证明 IndexedDB 容器可整体替换——AppProvider 与全部组件可脱离
 * IndexedDB 运行（见 src/state/AppState.memory.test.tsx）。
 * 数据仅存内存，无 seed、无持久化；AI provider 为可注入 stub。
 */
import type { AppServices } from "../../application/AppServices";
import type { AIProvider } from "../../domain/ai";
import { DocumentSaveCoordinator } from "../../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../../application/services/WorkspaceSessionService";
import { SearchIndexService } from "../../application/services/SearchIndexService";
import {
  createInMemoryRepositories,
  createMemoryStore,
  type MemoryStore,
} from "./repositories";

export interface InMemoryAppServicesOptions {
  /** 预置数据；缺省为全新空库。 */
  store?: MemoryStore;
  /** AI provider stub；缺省抛「未配置」错误。 */
  aiProvider?: AIProvider;
}

/** 创建内存容器；返回 store 便于测试直接断言底层数据。 */
export function createInMemoryAppServices(options: InMemoryAppServicesOptions = {}): {
  services: AppServices;
  store: MemoryStore;
} {
  const store = options.store ?? createMemoryStore();
  const repos = createInMemoryRepositories(store);
  const session = new WorkspaceSessionService({
    pages: repos.page,
    tags: repos.tag,
    content: repos.content,
  });
  const searchIndex = new SearchIndexService();
  // 内存恢复缓冲：与 localStorage 版同接口，数据随容器存活。
  const recoveryData = new Map<
    string,
    { pageId: string; contentJson: unknown; generation: number; timestamp: number }
  >();
  const write = (record: {
    pageId: string;
    contentJson: unknown;
    generation: number;
    timestamp: number;
  }) => {
    recoveryData.set(record.pageId, record);
  };
  const services: AppServices = {
    ...repos,
    session,
    searchIndex,
    createAIProvider:
      options.aiProvider !== undefined
        ? () => options.aiProvider as AIProvider
        : () => {
            throw new Error("内存容器未配置 AI provider");
          },
    createSaveCoordinator: (pageId, onStateChange) =>
      new DocumentSaveCoordinator(pageId, {
        content: repos.content,
        revisions: repos.revision,
        attachments: repos.attachment,
        recovery: {
          write,
          clear: (pid, savedGeneration) => {
            const record = recoveryData.get(pid);
            if (record && record.generation <= savedGeneration) {
              recoveryData.delete(pid);
            }
          },
        },
        onSaved: (pid, text, at) => searchIndex.updateText(pid, text, at),
        onStateChange,
      }),
  };
  return { services, store };
}
