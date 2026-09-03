/**
 * 内存服务容器（R003 阶段 5）：AppServices 的纯内存实现。
 * 证明 IndexedDB 容器可整体替换——AppProvider 与全部组件可脱离
 * IndexedDB 运行（见 src/state/AppState.memory.test.tsx）。
 * 数据仅存内存，无 seed、无持久化；AI provider 为可注入 stub。
 */
import type { AppServices } from "../../application/AppServices";
import type { AIProvider } from "../../domain/ai";
import { increment } from "../../application/devDiagnostics";
import { DocumentCommitService } from "../../application/services/DocumentCommitService";
import { DocumentSaveCoordinator } from "../../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../../application/services/WorkspaceSessionService";
import { PreferencesService } from "../../application/services/PreferencesService";
import { createInMemoryDocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import {
  BroadcastChangeChannel,
  type BroadcastChannelLike,
} from "../../platform/web/BroadcastChangeChannel";
import { InMemoryRecoveryStore } from "./recoveryStore";
import { InMemorySecretStore } from "./secretStore";
import { InMemoryStorageHealthService } from "./storageHealth";
import { AIConfigService } from "../../application/services/AIConfigService";
import { WorkspaceCommandService } from "../../application/commands/WorkspaceCommandService";
import { PageCommandService } from "../../application/commands/PageCommandService";
import { TagCommandService } from "../../application/commands/TagCommandService";
import { DocumentCommandService } from "../../application/commands/DocumentCommandService";
import { WorkspaceQueryService } from "../../application/queries/WorkspaceQueryService";
import { DocumentQueryService } from "../../application/queries/DocumentQueryService";
import { SearchQueryService } from "../../application/queries/SearchQueryService";
import {
  createInMemoryRepositories,
  createMemoryStore,
  type MemoryStore,
} from "./repositories";
import {
  InMemoryAssetAccessService,
  StubAssetPicker,
  StubNotificationService,
} from "./assetServices";
import { AssetCommandService } from "../../application/assets/AssetCommandService";
import { webCapabilities } from "../../platform/web/webCapabilities";
import { webOperations } from "../../platform/web/webOperations";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";
import type { RuntimeOperations } from "../../runtime/RuntimeOperations";

export interface InMemoryAppServicesOptions {
  /** 预置数据；缺省为全新空库。 */
  store?: MemoryStore;
  /** AI provider stub；缺省抛「未配置」错误。 */
  aiProvider?: AIProvider;
  /**
   * 变更广播频道的 mock 传输层（R004 §7.2；R005 阶段 8 §8.3 起为
   * ChangeChannel port 的 Web 实现注入）；缺省 null（no-op）。
   * 测试注入 mock 后可验证发送/接收/回声抑制。
   */
  syncChannel?: BroadcastChannelLike | null;
  /**
   * 能力矩阵覆盖（R006 阶段 1）：缺省 webCapabilities（测试环境即 Web
   * 语义）；Desktop fake adapter 经本参数注入 desktopCapabilities。
   */
  capabilities?: RuntimeCapabilities;
  /**
   * 操作支持矩阵覆盖（R007 阶段 4 §9）：缺省 webOperations（全 true，
   * 测试环境即 Web 语义）；Desktop 门控用例经本参数注入裁剪矩阵。
   */
  operations?: RuntimeOperations;
}

/**
 * 内存容器返回类型：公开面以 AppServices 为准（R005 批次 2 已收紧，
 * 不再暴露原始仓储）；此处额外携带底层仓储与服务实例，仅作测试
 * 直取数据的过渡通道——生产代码一律按 AppServices 类型访问。
 */
export type InMemoryAppServices = AppServices &
  ReturnType<typeof createInMemoryRepositories> & {
    documentCommit: DocumentCommitService;
    session: WorkspaceSessionService;
    searchIndex: BrowserMemorySearchIndex;
  };

/** 创建内存容器；返回 store 便于测试直接断言底层数据。 */
export function createInMemoryAppServices(
  options: InMemoryAppServicesOptions = {},
): {
  services: InMemoryAppServices;
  store: MemoryStore;
} {
  const store = options.store ?? createMemoryStore();
  const repos = createInMemoryRepositories(store);
  const session = new WorkspaceSessionService({
    pages: repos.page,
    tags: repos.tag,
  });
  // 搜索索引（R005 阶段 6）：与生产同为 Web 内存实现，仓储换内存版。
  const searchIndex = new BrowserMemorySearchIndex({
    pages: repos.page,
    content: repos.content,
  });
  // 变更广播频道（R004 §7.2）：默认 no-op；测试经 options 注入 mock。
  const syncChannel = new BroadcastChangeChannel(
    options.syncChannel ?? null,
    `test-tab-${Math.random().toString(36).slice(2)}`,
  );
  // 文档提交服务（R004 阶段 2）：与生产容器同装配。
  const documentCommit = new DocumentCommitService({
    content: repos.content,
    documentWrite: repos.documentWrite,
    revisions: repos.revision,
    searchIndex,
    syncChannel,
  });
  // 偏好写入服务单例（R005 批次 2）：与生产容器同装配（广播走注入的频道）。
  const preferencesService = new PreferencesService({
    preferences: repos.preferences,
    onError: (err) => console.error("偏好写入失败", err),
    onPersisted: () => syncChannel.publish({ type: "preferences-changed" }),
  });
  // 内存恢复缓冲（R005 阶段 8 §8.1）：RecoveryStore port 的内存实现，
  // 与 Web localStorage 版同契约，数据随容器存活。
  const recoveryStore = new InMemoryRecoveryStore();
  // 机密存储与 AI 配置组装（R005 阶段 8 §8.2）：与生产容器同装配。
  const secretStore = new InMemorySecretStore();
  const aiConfigService = new AIConfigService({
    preferences: preferencesService,
    secrets: secretStore,
  });
  // R010 Stage 6：documentQueries 先行构造——commands.document 的
  // relocateBrokenLink 复用同一实例读取源文档（openDocument 打开语义）。
  const documentQueries = new DocumentQueryService({
    content: repos.content,
    revisions: repos.revision,
  });
  const services: InMemoryAppServices = {
    // 底层仓储与服务实例：仅作测试过渡通道（见 InMemoryAppServices 注释），
    // AppServices 公开面不再包含这些字段（R005 批次 2）。
    ...repos,
    documentCommit,
    session,
    searchIndex,
    preferencesService,
    syncChannel,
    // 文档版本推进通道（R007 阶段 1）：内存 pub/sub，测试容器同形状。
    documentVersionChannel: createInMemoryDocumentVersionChannel(),
    recoveryStore,
    secretStore,
    aiConfigService,
    // 存储健康（R005 阶段 8 §8.4）：estimate 降级 null，事件可手工注入。
    storageHealth: new InMemoryStorageHealthService(),
    // 资源服务组（R005 阶段 5）：与生产容器同形状，访问/选择/反馈为内存桩。
    assets: {
      commands: new AssetCommandService({ store: repos.assetStore }),
      access: new InMemoryAssetAccessService(repos.assetStore),
      picker: new StubAssetPicker(),
      notify: new StubNotificationService(),
    },
    // 运行时能力矩阵（R005 阶段 2）：缺省 webCapabilities（测试环境即 Web
    // 语义）；R006 阶段 1 起 Desktop fake adapter 经 options 覆盖。
    capabilities: options.capabilities ?? webCapabilities,
    // 操作支持矩阵（R007 阶段 4 §9）：缺省 webOperations（全 true）。
    operations: options.operations ?? webOperations,
    // 命令/查询服务（R005 批次 1）：与生产容器同装配。
    commands: {
      workspace: new WorkspaceCommandService({
        workspace: repos.workspace,
        syncChannel,
      }),
      page: new PageCommandService({
        page: repos.page,
        searchIndex,
        syncChannel,
      }),
      tag: new TagCommandService({ tag: repos.tag }),
      document: new DocumentCommandService({
        documentCommit,
        documentQueries,
        syncChannel,
      }),
    },
    queries: {
      workspace: new WorkspaceQueryService({
        workspace: repos.workspace,
        page: repos.page,
        tag: repos.tag,
        session,
        searchIndex,
      }),
      document: documentQueries,
      search: new SearchQueryService({ searchIndex, content: repos.content }),
    },
    createAIProvider:
      options.aiProvider !== undefined
        ? () => options.aiProvider as AIProvider
        : () => {
            throw new Error("内存容器未配置 AI provider");
          },
    createSaveCoordinator: (pageId, onStateChange, coordinatorOptions) =>
      new DocumentSaveCoordinator(
        pageId,
        {
          committer: documentCommit,
          revisions: repos.revision,
          assets: repos.assetStore,
          recovery: recoveryStore,
          // 维护失败只记录开发诊断（R004 阶段 1），与生产容器一致。
          onMaintenanceError: (stage) =>
            increment("save-maintenance-error", stage),
          onStateChange,
        },
        { initialVersion: coordinatorOptions?.initialVersion },
      ),
  };
  return { services, store };
}
