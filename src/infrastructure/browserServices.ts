/**
 * 生产环境服务装配根（R003 阶段 5）：把 IndexedDB 仓储、AI HTTP
 * provider、localStorage 恢复缓冲组装为 AppServices 容器。
 * 这是 application 层接口与浏览器/IndexedDB 实现之间的唯一汇合点；
 * main.tsx 与测试装配（TestApp）共用。
 */
import type { AppServices } from "../application/AppServices";
import { DocumentSaveCoordinator } from "../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../application/services/WorkspaceSessionService";
import { SearchIndexService } from "../application/services/SearchIndexService";
import {
  clearRecovery,
  writeRecovery,
} from "../application/services/documentRecovery";
import { createOpenAICompatibleProvider } from "./aiProvider";
import {
  attachmentRepository,
  contentRepository,
  pageRepository,
  preferencesRepository,
  revisionRepository,
  tagRepository,
  workspaceRepository,
} from "./repositories";

/** 模块级单例：仓储本身无状态（连接由 db.ts 管理），全应用共享一个容器。 */
let instance: AppServices | null = null;

export function createBrowserAppServices(): AppServices {
  if (instance) return instance;
  const session = new WorkspaceSessionService({
    pages: pageRepository,
    tags: tagRepository,
    content: contentRepository,
  });
  const searchIndex = new SearchIndexService();
  instance = {
    workspace: workspaceRepository,
    page: pageRepository,
    content: contentRepository,
    revision: revisionRepository,
    attachment: attachmentRepository,
    tag: tagRepository,
    preferences: preferencesRepository,
    session,
    searchIndex,
    createAIProvider: createOpenAICompatibleProvider,
    createSaveCoordinator: (pageId, onStateChange) =>
      new DocumentSaveCoordinator(pageId, {
        content: contentRepository,
        revisions: revisionRepository,
        attachments: attachmentRepository,
        recovery: { write: writeRecovery, clear: clearRecovery },
        // 保存成功 → 搜索索引增量更新（R003 阶段 7）。
        onSaved: (pid, text, at) => searchIndex.updateText(pid, text, at),
        onStateChange,
      }),
  };
  return instance;
}
