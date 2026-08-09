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
 *   localStorage 恢复缓冲（R005 阶段 8 起经 RecoveryStore port 注入））；
 * - 测试/可替换性证明：src/infrastructure/memory/（纯内存仓储）。
 * 本文件不依赖任何具体实现。
 */
import type { AIProvider } from "../domain/ai";
import type { AIConfig, ContentVersionToken } from "../domain/types";
import type { AssetServices } from "./assets/assetServices";
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
import type { ChangeChannel } from "./services/ChangeChannel";
import type { RecoveryStore } from "./services/RecoveryStore";
import type { SecretStore } from "./services/SecretStore";
import type { AIConfigService } from "./services/AIConfigService";
import type { StorageHealthService } from "./services/StorageHealthService";
import type { RuntimeCapabilities } from "../runtime/RuntimeCapabilities";

/** 应用服务容器：命令/查询服务 + 跨领域应用服务工厂。 */
export interface AppServices {
  /**
   * 附件与资源访问服务组（R005 阶段 5）：导入/删除编排、二进制读取与
   * 临时 URL/下载、文件选择、用户反馈通道。编辑器扩展经
   * editor.storage.assetServices 消费（DocumentEditor 装配时注入），
   * 容器不再公开原始附件 port。
   */
  assets: AssetServices;
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
   * R004 阶段 7；R005 阶段 3 起为不透明 ContentVersionToken）；
   * 缺省 INITIAL_CONTENT_VERSION_TOKEN（尚无正文记录的新文档）。
   */
  createSaveCoordinator(
    pageId: string,
    onStateChange?: (state: SaveCoordinatorState) => void,
    options?: { initialVersion?: ContentVersionToken },
  ): DocumentSaveCoordinator;
  /**
   * 变更广播频道（R004 §7.2；R005 阶段 8 §8.3 抽象为 ChangeChannel port）。
   * Web 实现为 platform/web/BroadcastChangeChannel（BroadcastChannel +
   * tabId 回声抑制；无 BroadcastChannel 环境为 no-op 实例）。
   */
  syncChannel: ChangeChannel;
  /**
   * 恢复缓冲（R005 阶段 8 §8.1 RecoveryStore port）：编辑器未落盘内容的
   * 兜底读写；保存协调器经窄接口 RecoverySink 写入，启动恢复提示与
   * 「丢弃/重新载入」经本字段消费。Web 实现为 localStorage
   * （platform/web/webRecoveryStore），内存实现随内存容器存活。
   */
  recoveryStore: RecoveryStore;
  /**
   * 机密存储（R005 阶段 8 §8.2 SecretStore port）：AI API Key 等机密值
   * 与普通偏好模型分离。Web 实现为 IndexedDB secrets store
   * （infrastructure/secretStore.ts，DB v5），内存实现随内存容器存活。
   */
  secretStore: SecretStore;
  /**
   * AI 配置组装服务（R005 阶段 8 §8.2）：endpoint/model 取偏好、
   * apiKey 取 SecretStore，createAIProvider 调用方的统一取数通道。
   */
  aiConfigService: AIConfigService;
  /**
   * 存储健康服务（R005 阶段 8 §8.4 StorageHealthService port）：
   * 存储用量估算（设置页）+ 连接生命周期事件订阅（AppShell 提示条）。
   * Web 实现为 platform/web/webStorageHealth（navigator.storage +
   * db.ts 回调接线）；替代原 storageEvents 字段（StorageConnectionEventBus
   * 与 StorageQuotaService 模块均已删除）。
   */
  storageHealth: StorageHealthService;
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
