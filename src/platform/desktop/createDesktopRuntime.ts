/**
 * R006 阶段 2（C2）：Desktop 运行时装配——IPC-backed 真实适配。
 *
 * 与 Web 装配根（infrastructure/browserServices.ts）同构，仓储换成
 * platform/desktop 的 IPC-backed 实现：知识库/页面/标签读路径经
 * E1DesktopAPI 走 Main 文件系统（vault:listRecent / vault:openRecent /
 * vault:openSelection / vault:scan），正文经 note.read 真实读取
 * （R006-C3，DesktopContentRepository）；写路径抛 DomainError("NOT_IMPLEMENTED")
 * 诚实失败（note.create/save 属 C4，附件属阶段 5）。
 *
 * 复用说明（platform/desktop → platform/web 方向）：
 * BrowserMemorySearchIndex / BroadcastChangeChannel / WebRecoveryStore /
 * webAsset* 均为「只依赖 renderer 标准能力」的实现，Electron renderer
 * 同样可用，直接复用而非另写桌面副本；deps:check 不禁止该方向。
 * secretStore/storageHealth 用内存实现（nativeSecrets=false，
 * DesktopSecretStore 接系统安全存储属阶段 6+/R007，见 r006 §21）。
 */
import type { AppServices } from "../../application/AppServices";
import { increment } from "../../application/devDiagnostics";
import { DocumentCommitService } from "../../application/services/DocumentCommitService";
import { DocumentSaveCoordinator } from "../../application/services/SaveCoordinator";
import { WorkspaceSessionService } from "../../application/services/WorkspaceSessionService";
import { PreferencesService } from "../../application/services/PreferencesService";
import { AIConfigService } from "../../application/services/AIConfigService";
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
import { WebAssetAccessService } from "../web/webAssetAccess";
import { WebAssetPicker } from "../web/webAssetPicker";
import { WebNotificationService } from "../web/webNotification";
import { InMemorySecretStore } from "../../infrastructure/memory/secretStore";
import { InMemoryStorageHealthService } from "../../infrastructure/memory/storageHealth";
import { createOpenAICompatibleProvider } from "../../infrastructure/aiProvider";
import { desktopCapabilities } from "./desktopCapabilities";
import type { E1DesktopAPI } from "./desktopApi";
import {
  DesktopContentRepository,
  DesktopPageRepository,
  DesktopTagRepository,
  DesktopVaultScanCache,
  DesktopWorkspaceRepository,
} from "./repositories";
import {
  DesktopAssetStore,
  DesktopDocumentWriteRepository,
  DesktopRevisionRepository,
} from "./stubRepositories";
import { DesktopPreferencesRepository } from "./preferencesRepository";

export interface DesktopRuntime {
  services: AppServices;
  capabilities: RuntimeCapabilities;
}

/** 基于桌面桥装配完整 AppServices 容器（读路径真实、写路径诚实失败）。 */
export function createDesktopRuntime(api: E1DesktopAPI): DesktopRuntime {
  // IPC-backed 仓储（扫描缓存跨仓储共享：会话加载的页面/标签读取
  // 与搜索索引准备只触发一次真实扫描）。
  const scans = new DesktopVaultScanCache(api);
  const workspaceRepository = new DesktopWorkspaceRepository(api);
  const pageRepository = new DesktopPageRepository(api, scans);
  const contentRepository = new DesktopContentRepository(api, scans);
  const tagRepository = new DesktopTagRepository(scans);
  const revisionRepository = new DesktopRevisionRepository();
  const assetStore = new DesktopAssetStore();
  const documentWriteRepository = new DesktopDocumentWriteRepository();
  // 偏好：localStorage（lastRoute 持久化支撑 US-06 重开自动进入最近 Vault）。
  const preferencesRepository = new DesktopPreferencesRepository();

  const session = new WorkspaceSessionService({
    pages: pageRepository,
    tags: tagRepository,
  });
  // 搜索索引：复用 Web 内存实现；正文仓储的 listAll/listByWorkspace 恒空
  // （R006-C3 §35：C3 不扩大 Desktop 搜索，打开 Vault 不全量读正文），
  // 索引只含标题元数据。
  const searchIndex = new BrowserMemorySearchIndex({
    pages: pageRepository,
    content: contentRepository,
  });
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
  // 机密存储：内存实现（PoC）；apiKey 不持久，重启后需重填——
  // nativeSecrets 保持 false，接系统安全存储属阶段 6+/R007。
  const secretStore = new InMemorySecretStore();
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
    }),
  };
  // 资源服务组：picker/access/notify 复用 Web 适配（input file、Object URL、
  // alert 在 Electron renderer 均可用）；store 为桩，附件导入落库抛
  // NOT_IMPLEMENTED（属阶段 5），UI 不崩、用户得到明确错误。
  const assets: AssetServices = {
    commands: new AssetCommandService({ store: assetStore }),
    access: new WebAssetAccessService(assetStore),
    picker: new WebAssetPicker(),
    notify: new WebNotificationService(),
  };
  const services: AppServices = {
    assets,
    capabilities: desktopCapabilities,
    // FR-26「重新扫描知识库」过渡通道（PoC）：缓存失效 + 新快照预热；
    // 页面树/标签镜像刷新由 UI 经 refreshCurrentWorkspace 命令完成。
    desktopExtras: {
      rescanVault: async (vaultId) => {
        await scans.rescan(vaultId);
      },
    },
    preferencesService,
    syncChannel,
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
  return { services, capabilities: desktopCapabilities };
}
