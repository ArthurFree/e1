/**
 * 应用服务容器接口（R003 阶段 5）：UI 与状态层访问应用能力的唯一入口。
 *
 * R005 批次 2 收紧公开面（阶段 1 / DUAL-02）：容器不再暴露原始仓储，
 * 业务编排一律经 commands/queries 两组命令/查询服务，偏好写入经
 * preferencesService 单例；原始仓储只经构造函数注入 application 服务，
 * 由装配根持有（决策见 docs/decisions.md 与 docs/architecture/runtime-boundaries.md）。
 *
 * 实现：
 * - 生产：src/infrastructure/browserServices.ts（IndexedDB + AI HTTP +
 *   localStorage 恢复缓冲）；
 * - 测试/可替换性证明：src/infrastructure/memory/（纯内存仓储）。
 * 本文件不依赖任何具体实现。
 */
import type { AIProvider } from "../domain/ai";
import type { AttachmentRepository } from "../domain/repositories";
import type { AIConfig } from "../domain/types";
import type { PreferencesService } from "./services/PreferencesService";
import type { WorkspaceCommandService } from "./commands/WorkspaceCommandService";
import type { PageCommandService } from "./commands/PageCommandService";
import type { TagCommandService } from "./commands/TagCommandService";
import type { DocumentCommandService } from "./commands/DocumentCommandService";
import type { WorkspaceQueryService } from "./queries/WorkspaceQueryService";
import type { DocumentQueryService } from "./queries/DocumentQueryService";
import type { SearchQueryService } from "./queries/SearchQueryService";
import type {
  DocumentSaveCoordinator,
  SaveCoordinatorState,
} from "./services/SaveCoordinator";
import type { SyncChannelService } from "./services/SyncChannelService";
import type { StorageConnectionEventBus } from "./services/StorageConnectionEventBus";
import type { RuntimeCapabilities } from "../runtime/RuntimeCapabilities";

/** 应用服务容器：命令/查询服务 + 跨领域应用服务工厂。 */
export interface AppServices {
  // TODO(R005-13/14)：阶段 5 Asset 抽象后移除公开附件仓储
  // （当前经 editor.storage 通道供 Tiptap 附件扩展读取）。
  attachment: AttachmentRepository;
  /**
   * 偏好写入服务单例（R005 批次 2）：装配根构造，串行写入队列 +
   * dispose/resume 生命周期；PreferencesProvider 直接消费本实例。
   */
  preferencesService: PreferencesService;
  /** AI provider 工厂（OpenAI 兼容协议）；未配置 AI 时不发起任何请求。 */
  createAIProvider(config: AIConfig): AIProvider;
  /**
   * 保存协调器工厂：隐藏正文/版本/附件三仓储与恢复缓冲的装配细节，
   * 每个文档一个实例，销毁由调用方负责。
   * initialVersion 为编辑器加载正文时的 content.version（乐观锁起点，
   * R004 阶段 7）；缺省 0（尚无正文记录的新文档）。
   */
  createSaveCoordinator(
    pageId: string,
    onStateChange?: (state: SaveCoordinatorState) => void,
    options?: { initialVersion?: number },
  ): DocumentSaveCoordinator;
  /** 跨标签页同步频道（R004 §7.2）；无 BroadcastChannel 环境为 no-op 实例。 */
  syncChannel: SyncChannelService;
  /** 存储连接事件总线（R004 §7.1）：blocked/versionchange/terminated 提示。 */
  storageEvents: StorageConnectionEventBus;
  /**
   * 运行时能力矩阵（R005 阶段 2，DUAL-01）：组件经
   * useAppServices().capabilities 判断能力，不得判断平台名称。
   * Web 实现为 platform/web/webCapabilities（六字段全 false）。
   */
  capabilities: RuntimeCapabilities;
  /**
   * 命令服务（R005 批次 1）：业务写编排入口，状态层经此触发仓储写、
   * 搜索索引同步与跨标签页广播。
   */
  commands: {
    workspace: WorkspaceCommandService;
    page: PageCommandService;
    tag: TagCommandService;
    document: DocumentCommandService;
  };
  /** 查询服务（R005 批次 1）：只读编排入口（会话/页面/标签/正文/搜索）。 */
  queries: {
    workspace: WorkspaceQueryService;
    document: DocumentQueryService;
    search: SearchQueryService;
  };
}
