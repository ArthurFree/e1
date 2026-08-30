/**
 * R006 阶段 2（C2）+ C4：Desktop 运行时装配——IPC-backed 真实适配。
 *
 * 与 Web 装配根（platform/web/createBrowserServices.ts）同构，仓储换成
 * platform/desktop 的 IPC-backed 实现：知识库/页面/标签读路径经
 * E1DesktopAPI 走 Main 文件系统；正文经 note.read/save/create
 *（R006-C3/C4，DesktopContentRepository + DocumentWriteRepository）。
 * 附件经 DesktopAssetStore 落 Vault/assets/（R006-C5）。
 *
 * 复用说明（platform/desktop → platform/web 方向）：
 * BrowserMemorySearchIndex / BroadcastChangeChannel / WebRecoveryStore /
 * webNotification 为「只依赖 renderer 标准能力」的实现，Electron renderer
 * 同样可用；附件 Picker/Access 已换 Desktop 实现（R006-C5）。
 * R007 阶段 5：secretStore 换 DesktopSecretStore（Main safeStorage
 * 持久化；不可用时 Main 会话内存降级，nativeSecrets 由装配根按
 * secret.status 传入实际值）；reveal 接 DesktopRevealService。
 */
import type {
  AppServices,
  DocumentSafetyPort,
  VaultMaintenancePort,
} from "../../application/AppServices";
import { increment } from "../../application/devDiagnostics";
import { DocumentCommitService } from "../../application/services/DocumentCommitService";
import { DocumentSaveCoordinator } from "../../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../../application/services/WorkspaceSessionService";
import { PreferencesService } from "../../application/services/PreferencesService";
import { AIConfigService } from "../../application/services/AIConfigService";
import type { SecretStorageStatus } from "../../application/services/SecretStorageStatus";
import { WorkspaceCommandService } from "../../application/commands/WorkspaceCommandService";
import { PageCommandService } from "../../application/commands/PageCommandService";
import { TagCommandService } from "../../application/commands/TagCommandService";
import { DocumentCommandService } from "../../application/commands/DocumentCommandService";
import { WorkspaceQueryService } from "../../application/queries/WorkspaceQueryService";
import { DocumentQueryService } from "../../application/queries/DocumentQueryService";
import { SearchQueryService } from "../../application/queries/SearchQueryService";
import { AssetCommandService } from "../../application/assets/AssetCommandService";
import type { AssetServices } from "../../application/assets/assetServices";
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";
import { BrowserMemorySearchIndex } from "../web/search/BrowserMemorySearchIndex";
import { BroadcastChangeChannel } from "../web/BroadcastChangeChannel";
import { WebRecoveryStore } from "../web/webRecoveryStore";
import { WebNotificationService } from "../web/webNotification";
import { WebAssetPicker } from "../web/webAssetPicker";
import { InMemoryStorageHealthService } from "../../infrastructure/memory/storageHealth";
import { createOpenAICompatibleProvider } from "../../infrastructure/aiProvider";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import { desktopCapabilities } from "./desktopCapabilities";
import { desktopOperations } from "./desktopOperations";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { DesktopMarkdownWriteService } from "./DesktopMarkdownWriteService";
import { DesktopNoteMetadataService } from "./DesktopNoteMetadataService";
import { DesktopVaultStateClient } from "./DesktopVaultStateClient";
import { DesktopSecretStore } from "./DesktopSecretStore";
import { DesktopRevealService } from "./DesktopRevealService";
import { DesktopUpdateService } from "./DesktopUpdateService";
import { DesktopSearchIndex } from "./DesktopSearchIndex";
import { DesktopSearchIndexReconciler } from "./DesktopSearchIndexReconciler";
import { DesktopExternalVaultChangeService } from "./DesktopExternalVaultChangeService";
import { createInMemoryDocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import { DesktopAssetStore } from "./DesktopAssetStore";
import { DesktopAssetPicker } from "./DesktopAssetPicker";
import { DesktopAssetAccessService } from "./DesktopAssetAccessService";
import {
  DesktopContentRepository,
  DesktopDocumentWriteRepository,
  DesktopPageRepository,
  DesktopTagRepository,
  DesktopVaultScanCache,
  DesktopWorkspaceRepository,
} from "./repositories";
import { DesktopRevisionRepository } from "./stubRepositories";
import { DesktopPreferencesRepository } from "./preferencesRepository";
import { DesktopTitleSearchIndex } from "./DesktopTitleSearchIndex";

export interface DesktopRuntime {
  services: AppServices;
  capabilities: RuntimeCapabilities;
}

/**
 * R008 Stage 1（R8-02）：机密存储运行状态——由装配根（main.desktop.tsx）
 * 先查 secret.status 再传入；缺省 unavailable（未探测时不声称安全）。
 */
export interface DesktopRuntimeOptions {
  secretStatus?: SecretStorageStatus;
}

/** 基于桌面桥装配完整 AppServices 容器（读路径真实、写路径诚实失败）。 */
export function createDesktopRuntime(
  api: E1DesktopAPI,
  options: DesktopRuntimeOptions = {},
): DesktopRuntime {
  const capabilities: RuntimeCapabilities = desktopCapabilities;
  // IPC-backed 仓储（扫描缓存跨仓储共享：会话加载的页面/标签读取
  // 与搜索索引准备只触发一次真实扫描）。Alias / Source / WriteService
  // 三份单例：Adoption 后 Session 身份稳定，save 与 replaceContent 共用 Gate。
  const aliases = new DesktopIdentityAliasRegistry();
  const assets = new DesktopAssetRegistry();
  const scans = new DesktopVaultScanCache(api, aliases);
  const sources = new DesktopDocumentSourceCache();
  const codec = createMarkdownCodec();
  const writer = new DesktopMarkdownWriteService(
    api,
    sources,
    scans,
    codec,
    assets,
  );
  // R007 阶段 1：元数据写入编排（rename/setPageTags 共用）与版本推进通道——
  // 元数据落盘后同步 Source Cache 并把新令牌推给打开文档的保存协调器。
  const documentVersionChannel = createInMemoryDocumentVersionChannel();
  const noteMetadata = new DesktopNoteMetadataService(
    api,
    scans,
    sources,
    documentVersionChannel,
  );
  // R007 阶段 2：设备级交互状态（收藏/最近打开）客户端——会话内缓存 +
  // transient 短路 + Adoption 键迁移；Workspace/Page 仓储共用同一实例。
  const vaultState = new DesktopVaultStateClient(api);
  const workspaceRepository = new DesktopWorkspaceRepository(api, vaultState);
  const pageRepository = new DesktopPageRepository(
    api,
    scans,
    noteMetadata,
    vaultState,
    sources,
  );
  const contentRepository = new DesktopContentRepository(
    api,
    scans,
    sources,
    codec,
    writer,
    assets,
  );
  const tagRepository = new DesktopTagRepository(scans, noteMetadata);
  const revisionRepository = new DesktopRevisionRepository();
  const assetStore = new DesktopAssetStore(api, scans, assets);
  const documentWriteRepository = new DesktopDocumentWriteRepository(
    api,
    scans,
    sources,
    codec,
    writer,
  );
  // 偏好：localStorage（lastRoute 持久化支撑 US-06 重开自动进入最近 Vault）。
  const preferencesRepository = new DesktopPreferencesRepository();

  const session = new WorkspaceSessionService({
    pages: pageRepository,
    tags: tagRepository,
  });
  // R008 Stage 4：全文搜索索引（Main SQLite 派生索引的 IPC 适配）。
  const fullTextSearch = new DesktopSearchIndex(api, scans);
  // R008 Stage 5：搜索索引 reconciler（外部事件 → 索引动作；自写钩子）。
  const searchReconciler = new DesktopSearchIndexReconciler({
    api,
    scans,
    aliases,
    fullText: fullTextSearch,
  });
  // 搜索索引：标题搜索（fallback 路径）；onCommitted 钩子——正文提交
  // 成功后通知 reconciler（自写 upsert，§12.4）。
  const searchIndex = new DesktopTitleSearchIndex(
    new BrowserMemorySearchIndex({
      pages: pageRepository,
      content: contentRepository,
    }),
    {
      onCommitted: (pageId) => {
        void searchReconciler.onDocumentCommitted(pageId);
      },
    },
  );
  // 变更广播：桌面单窗口无多标签页同步需求，null 传输层即 no-op 实例
  // （ChangeChannel port 形状保留，未来多窗口时再接真实传输）。
  const syncChannel = new BroadcastChangeChannel(null, "desktop-main-window");
  // 恢复缓冲：本机易失兜底，复用 localStorage 实现；阶段 3 编辑器接通后生效。
  const recoveryStore = new WebRecoveryStore();
  const storageHealth = new InMemoryStorageHealthService();
  const documentCommit = new DocumentCommitService({
    content: contentRepository,
    documentWrite: documentWriteRepository,
    revisions: revisionRepository,
    searchIndex,
    syncChannel,
  });
  const preferencesService = new PreferencesService({
    preferences: preferencesRepository,
    onError: (err) => console.error("偏好写入失败", err),
    onPersisted: () => syncChannel.publish({ type: "preferences-changed" }),
  });
  // 机密存储（R007 阶段 5）：Main safeStorage 加密持久化；系统安全存储
  // 不可用时 Main 降级会话内存（secret.status 报告，nativeSecrets=false）。
  const secretStore = new DesktopSecretStore(api);
  const aiConfigService = new AIConfigService({
    preferences: preferencesService,
    secrets: secretStore,
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
    document: new DocumentCommandService({ documentCommit, syncChannel }),
  };
  const queries = {
    workspace: new WorkspaceQueryService({
      workspace: workspaceRepository,
      page: pageRepository,
      tag: tagRepository,
      session,
      searchIndex,
    }),
    document: new DocumentQueryService({
      content: contentRepository,
      revisions: revisionRepository,
    }),
    search: new SearchQueryService({
      searchIndex,
      content: contentRepository,
      // R008 Stage 4：全文搜索（ready 时优先；未 ready 回退标题索引）。
      fullText: fullTextSearch,
    }),
  };
  // 资源服务组：Desktop 真实 Store/Picker/Access；notify 复用 Web alert。
  const assetsServices: AssetServices = {
    commands: new AssetCommandService({ store: assetStore }),
    access: new DesktopAssetAccessService(api, assets, assetStore),
    picker: new DesktopAssetPicker(api, new WebAssetPicker()),
    notify: new WebNotificationService(),
  };
  const vaultMaintenance: VaultMaintenancePort = {
    rescan: async (vaultId) => {
      await scans.rescan(vaultId);
    },
  };
  const documentSafety: DocumentSafetyPort = {
    approveLossySource: (pageId) => {
      contentRepository.getSourceCache().approveSourceLossy(pageId);
    },
    approveLossyOutput: (pageId) => {
      contentRepository.getSourceCache().approveOutputLossy(pageId);
    },
    approveIdentityAdoption: (pageId) => {
      const cache = contentRepository.getSourceCache();
      const existing = cache.get(pageId);
      // C4-F / C4.1-B：启用编辑时预生成 stableNoteId（会话 pageId 仍为
      // path:*）；首次 note.save 才把 id 写入 Frontmatter。同时登记
      // Session Alias，重新扫描不得把 Page.id 切到磁盘 stable id。
      if (existing && !existing.stableNoteId) {
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `id-${Date.now().toString(36)}`;
        cache.updateStableNoteId(pageId, id);
      }
      cache.approveIdentityAdoption(pageId);
      const latest = cache.get(pageId);
      if (latest?.stableNoteId) {
        aliases.register({
          vaultId: latest.vaultId,
          sessionPageId: pageId,
          stableNoteId: latest.stableNoteId,
          relativePath: latest.relativePath,
        });
      }
    },
  };
  // R007 阶段 3：外部 Vault 变更 reconciliation——订阅 Main Watcher 事件
  //（events:vaultChanges），静止窗口批量合并 + 扫描快照 diff 后向 UI
  // 发布归一化文档变更；页面树刷新桥（ExternalVaultChangeBridge）消费。
  const externalVaultChanges = new DesktopExternalVaultChangeService({
    api,
    scans,
    // R007 §3.4：moved 变更发布前同步来源缓存的过期路径（含 Adoption 会话别名）。
    sources,
    aliases,
  });
  externalVaultChanges.start();
  // R008 Stage 5（R8-05）：Watcher 事实 → 搜索索引动作（增量维护）。
  externalVaultChanges.subscribe((changes) => {
    void searchReconciler.reconcile(changes);
  });
  // R007 阶段 5：文件管理器定位（note.reveal/asset.reveal）。
  const reveal = new DesktopRevealService(api, scans);
  // R009 Stage 6（Auto Update）：应用更新——状态机在 Main 侧，
  // Renderer 只透传桥接（UI 以 services.update 存在性门控入口）。
  const update = new DesktopUpdateService(api);
  const services: AppServices = {
    assets: assetsServices,
    capabilities,
    // 操作支持矩阵（R007 阶段 4 §9）：未实现的操作 false，入口隐藏。
    operations: desktopOperations,
    // FR-26「重新扫描知识库」（PR5：VaultMaintenancePort）：缓存失效 +
    // 新快照预热；页面树/标签镜像刷新由 UI 经 refreshCurrentWorkspace 完成。
    vaultMaintenance,
    // 会话级保存门闸（PR5：DocumentSafetyPort）。
    documentSafety,
    // 外部 Vault 变更流（R007 阶段 3；消费侧以 capabilities.fileWatching 门控）。
    externalVaultChanges,
    // 文件管理器定位（R007 阶段 5；消费侧以 capabilities.revealInFileManager 门控）。
    reveal,
    // 应用更新（R009 Stage 6；消费侧以 services.update 存在性门控）。
    update,
    // 全文搜索索引（R008 Stage 4；SearchQueryService 在 ready 时优先消费）。
    fullTextSearch,
    // 机密存储运行状态（R008 Stage 1，R8-02）：secure-persistent 才持久，
    // 其余模式设置页提示「本次会话使用」；缺省未探测按 unavailable。
    secretStorageStatus: options.secretStatus ?? {
      mode: "unavailable",
      reason: "运行时未探测",
    },
    preferencesService,
    syncChannel,
    documentVersionChannel,
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
          onMaintenanceError: (stage) =>
            increment("save-maintenance-error", stage),
          onStateChange,
        },
        { initialVersion: options?.initialVersion },
      ),
  };
  return { services, capabilities };
}
