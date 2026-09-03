/**
 * Web 生产服务装配根（R003 阶段 5；PR6 自 infrastructure/browserServices.ts
 * 迁入 platform/web）：把 IndexedDB 仓储（./persistence）、AI HTTP provider、
 * localStorage 恢复缓冲组装为 AppServices 容器。
 * 这是 application 层接口与浏览器/IndexedDB 实现之间的唯一汇合点；
 * 生产由 platform/web/createWebRuntime 调用（R005 阶段 2），
 * 测试装配（TestApp）亦可直接使用。
 */
import type { AppServices } from "../../application/AppServices";
import { increment } from "../../application/devDiagnostics";
import { DocumentCommitService } from "../../application/services/DocumentCommitService";
import { DocumentSaveCoordinator } from "../../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../../application/services/WorkspaceSessionService";
import { PreferencesService } from "../../application/services/PreferencesService";
import { BroadcastChangeChannel } from "./BroadcastChangeChannel";
import { createInMemoryDocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import { WebRecoveryStore } from "./webRecoveryStore";
import { WebStorageHealthService } from "./webStorageHealth";
import { AIConfigService } from "../../application/services/AIConfigService";
import { WorkspaceCommandService } from "../../application/commands/WorkspaceCommandService";
import { PageCommandService } from "../../application/commands/PageCommandService";
import { TagCommandService } from "../../application/commands/TagCommandService";
import { DocumentCommandService } from "../../application/commands/DocumentCommandService";
import { WorkspaceQueryService } from "../../application/queries/WorkspaceQueryService";
import { DocumentQueryService } from "../../application/queries/DocumentQueryService";
import { SearchQueryService } from "../../application/queries/SearchQueryService";
import { createOpenAICompatibleProvider } from "../../infrastructure/aiProvider";
import { createId } from "../../infrastructure/id";
import { setStorageConnectionCallbacks } from "./persistence/db";
import { secretStore } from "./persistence/secretStore";
import { webCapabilities } from "./webCapabilities";
import { webOperations } from "./webOperations";
import { WebAssetAccessService } from "./webAssetAccess";
import { WebAssetPicker } from "./webAssetPicker";
import { WebNotificationService } from "./webNotification";
import { BrowserMemorySearchIndex } from "./search/BrowserMemorySearchIndex";
import { AssetCommandService } from "../../application/assets/AssetCommandService";
import type { AssetServices } from "../../application/assets/assetServices";
import {
  assetStore,
  contentRepository,
  documentWriteRepository,
  pageRepository,
  preferencesRepository,
  revisionRepository,
  tagRepository,
  workspaceRepository,
} from "./persistence/repositories";

/** 模块级单例：仓储本身无状态（连接由 db.ts 管理），全应用共享一个容器。 */
let instance: AppServices | null = null;

export function createBrowserAppServices(): AppServices {
  if (instance) return instance;
  const session = new WorkspaceSessionService({
    pages: pageRepository,
    tags: tagRepository,
  });
  // 搜索索引（R005 阶段 6）：Web 内存实现，自行经仓储读取页面与正文快照。
  const searchIndex = new BrowserMemorySearchIndex({
    pages: pageRepository,
    content: contentRepository,
  });
  // 变更广播频道（R004 §7.2；R005 阶段 8 §8.3 ChangeChannel port 的 Web
  // 实现）：无 BroadcastChannel 环境降级 no-op。
  const syncChannel = BroadcastChangeChannel.browser(createId());
  // 恢复缓冲（R005 阶段 8 §8.1 RecoveryStore port 的 Web 实现）：localStorage。
  const recoveryStore = new WebRecoveryStore();
  // 存储健康（R005 阶段 8 §8.4 StorageHealthService port 的 Web 实现）：
  // db.ts 连接生命周期回调 → emitConnectionEvent → UI 提示条。
  const storageHealth = new WebStorageHealthService();
  setStorageConnectionCallbacks({
    onBlocked: () => storageHealth.emitConnectionEvent("blocked"),
    onVersionChange: () => storageHealth.emitConnectionEvent("versionchange"),
    onTerminated: () => storageHealth.emitConnectionEvent("terminated"),
  });
  // 文档提交服务（R004 阶段 2）：正文落盘 + 搜索索引同步单点，
  // 保存协调器与外部文档写共用同一提交语义；落盘成功广播 content-saved。
  const documentCommit = new DocumentCommitService({
    content: contentRepository,
    documentWrite: documentWriteRepository,
    revisions: revisionRepository,
    searchIndex,
    syncChannel,
  });
  // 偏好写入服务单例（R005 批次 2）：串行队列防读-改-写竞态；
  // 非路由写入落盘后广播 preferences-changed（R004 §7.2，原 Provider 接线迁入）。
  const preferencesService = new PreferencesService({
    preferences: preferencesRepository,
    onError: (err) => console.error("偏好写入失败", err),
    onPersisted: () => syncChannel.publish({ type: "preferences-changed" }),
  });
  // AI 配置组装服务（R005 阶段 8 §8.2）：endpoint/model 取偏好、
  // apiKey 取 SecretStore（IndexedDB secrets store，DB v5 迁移自旧版
  // 偏好记录中的 aiConfig.apiKey）。
  const aiConfigService = new AIConfigService({
    preferences: preferencesService,
    secrets: secretStore,
  });
  // 命令/查询服务（R005 批次 1）：业务编排入口，注入既有仓储与服务实例。
  // R010 Stage 6：documentQueries 先行构造——commands.document 的
  // relocateBrokenLink 复用同一实例读取源文档（openDocument 打开语义）。
  const documentQueries = new DocumentQueryService({
    content: contentRepository,
    revisions: revisionRepository,
  });
  const commands = {
    workspace: new WorkspaceCommandService({
      workspace: workspaceRepository,
      syncChannel,
    }),
    page: new PageCommandService({
      page: pageRepository,
      searchIndex,
      syncChannel,
    }),
    tag: new TagCommandService({ tag: tagRepository }),
    document: new DocumentCommandService({
      documentCommit,
      documentQueries,
      syncChannel,
    }),
  };
  const queries = {
    workspace: new WorkspaceQueryService({
      workspace: workspaceRepository,
      page: pageRepository,
      tag: tagRepository,
      session,
      searchIndex,
    }),
    document: documentQueries,
    search: new SearchQueryService({
      searchIndex,
      content: contentRepository,
    }),
  };
  // 资源服务组（R005 阶段 5）：写编排平台无关（AssetCommandService），
  // URL/下载/文件选择/反馈为 Web 适配器（Blob 只在 platform/web 边界重建）。
  const assets: AssetServices = {
    commands: new AssetCommandService({ store: assetStore }),
    access: new WebAssetAccessService(assetStore),
    picker: new WebAssetPicker(),
    notify: new WebNotificationService(),
  };
  instance = {
    assets,
    // 运行时能力矩阵（R005 阶段 2）：写死在容器内部而非 spread 合并，
    // 保持模块级单例的引用相等（TestApp/消费者依赖同一实例身份）。
    capabilities: webCapabilities,
    // 操作支持矩阵（R007 阶段 4 §9）：Web 全部操作已实现，全 true。
    operations: webOperations,
    preferencesService,
    syncChannel,
    // 文档版本推进通道（R007 阶段 1）：Web 元数据写与正文同一事务，
    // 无发布方；装配同一内存实现保持容器形状一致。
    documentVersionChannel: createInMemoryDocumentVersionChannel(),
    recoveryStore,
    secretStore,
    aiConfigService,
    storageHealth,
    commands,
    queries,
    createAIProvider: createOpenAICompatibleProvider,
    createSaveCoordinator: (pageId, onStateChange, options) =>
      new DocumentSaveCoordinator(
        pageId,
        {
          committer: documentCommit,
          revisions: revisionRepository,
          assets: assetStore,
          recovery: recoveryStore,
          // 维护失败不影响正文保存状态，只记录开发诊断（R004 阶段 1）。
          onMaintenanceError: (stage) =>
            increment("save-maintenance-error", stage),
          onStateChange,
        },
        { initialVersion: options?.initialVersion },
      ),
  };
  return instance;
}
