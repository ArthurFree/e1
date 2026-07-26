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
  PageRepository,
  PreferencesRepository,
  RevisionRepository,
  TagRepository,
  WorkspaceRepository,
} from "../domain/repositories";
import type { AIConfig } from "../domain/types";
import type { WorkspaceSessionService } from "./services/WorkspaceSessionService";
import type { SearchIndexService } from "./services/SearchIndexService";
import type {
  DocumentSaveCoordinator,
  SaveCoordinatorState,
} from "./services/SaveCoordinator";

/** 应用服务容器：按领域分组的仓储 port + 应用服务工厂。 */
export interface AppServices {
  workspace: WorkspaceRepository;
  page: PageRepository;
  content: ContentRepository;
  revision: RevisionRepository;
  attachment: AttachmentRepository;
  tag: TagRepository;
  preferences: PreferencesRepository;
  /** 知识库会话原子加载（无状态，可共享单例）。 */
  session: WorkspaceSessionService;
  /** 工作区级内存搜索索引（R003 阶段 7）。 */
  searchIndex: SearchIndexService;
  /** AI provider 工厂（OpenAI 兼容协议）；未配置 AI 时不发起任何请求。 */
  createAIProvider(config: AIConfig): AIProvider;
  /**
   * 保存协调器工厂：隐藏正文/版本/附件三仓储与恢复缓冲的装配细节，
   * 每个文档一个实例，销毁由调用方负责。
   */
  createSaveCoordinator(
    pageId: string,
    onStateChange?: (state: SaveCoordinatorState) => void,
  ): DocumentSaveCoordinator;
}
