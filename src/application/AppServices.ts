/**
 * 应用服务容器接口（R003 阶段 5）：UI 与状态层访问应用能力的唯一入口。
 *
 * 容器按领域分组暴露仓储 port（domain/repositories）与 application 层
 * 既有服务；用例编排由 AppState actions 与这三个服务承载，不另建
 * 同义 use-case 类（决策见 docs/decisions.md）。
 *
 * 实现：
 * - 生产：src/infrastructure/browserServices.ts（IndexedDB + AI HTTP +
 *   localStorage 恢复缓冲）；
 * - 测试/可替换性证明：src/infrastructure/memory/（纯内存仓储）。
 * 本文件不依赖任何具体实现。
 */
import type { AIProvider } from "../domain/ai";
import type {
  AttachmentRepository,
  ContentRepository,
  DocumentWriteRepository,
  PageRepository,
  PreferencesRepository,
  RevisionRepository,
  TagRepository,
  WorkspaceRepository,
} from "../domain/repositories";
import type { AIConfig } from "../domain/types";
import type { WorkspaceSessionService } from "./services/WorkspaceSessionService";
import type { SearchIndexService } from "./services/SearchIndexService";
import type { DocumentCommitService } from "./services/DocumentCommitService";
import type {
  DocumentSaveCoordinator,
  SaveCoordinatorState,
} from "./services/SaveCoordinator";
import type { SyncChannelService } from "./services/SyncChannelService";
import type { StorageConnectionEventBus } from "./services/StorageConnectionEventBus";

/** 应用服务容器：按领域分组的仓储 port + 应用服务工厂。 */
export interface AppServices {
  workspace: WorkspaceRepository;
  page: PageRepository;
  content: ContentRepository;
  revision: RevisionRepository;
  attachment: AttachmentRepository;
  tag: TagRepository;
  preferences: PreferencesRepository;
  /** 原子文档写仓储（R004 阶段 2，INV-04）：页面与初始正文单事务创建。 */
  documentWrite: DocumentWriteRepository;
  /** 文档提交服务（R004 阶段 2）：正文写入 + 搜索索引同步单点（INV-05）。 */
  documentCommit: DocumentCommitService;
  /** 知识库会话原子加载（无状态，可共享单例）。 */
  session: WorkspaceSessionService;
  /** 工作区级内存搜索索引（R003 阶段 7）。 */
  searchIndex: SearchIndexService;
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
}
