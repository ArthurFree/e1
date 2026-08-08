/**
 * 领域实体类型：UI、状态层与仓储层共享的数据模型契约（见 docs/architecture.md「数据模型」）。
 * 本文件只定义形状，不含业务逻辑；唯一的运行时产物是默认偏好常量。
 * 两条全局约定：
 * - 文档内容以 DocumentContent.contentJson（Tiptap JSON）为唯一编辑真相，
 *   textSnapshot 仅用于全局搜索与 Markdown 导出；
 * - 页面删除一律走软删除（deletedAt 时间戳），回收站恢复后再考虑物理清除。
 */

/** 页面类型：document 为可编辑文档，group 为仅作树节点的分组（无正文）。 */
export type PageKind = "document" | "group";

/**
 * 正文乐观并发版本令牌（R005 阶段 3）：平台无关的不透明字符串，
 * 应用层一律原样传递，不得解析、比较大小或做算术。
 * 编码由各持久化实现自定（Web IndexedDB 为 "idb:N"，内存实现为 "mem:N"，
 * 未来 Desktop 可为 "sha256:..." 等）；见 docs/requirements/r005.md §八。
 */
export type ContentVersionToken = string;

/**
 * 初始版本令牌（R005 阶段 3）：空串表示「应无既有正文版本」——
 * 新文档尚无正文记录、或存量记录从未写过版本时的乐观锁起点。
 * 各仓储实现把它映射到自己的内部初始版本（如 IndexedDB 的 number 0）。
 */
export const INITIAL_CONTENT_VERSION_TOKEN: ContentVersionToken = "";

/** 知识库（R001）：页面树的根对象，一个工作区内可有多个。 */
export interface Workspace {
  id: string;
  name: string;
  /** 用户自定义图标（Emoji 或图标名）；null 时由 UI 使用默认图标。 */
  icon: string | null;
  description: string;
  /** 预留：自定义首页文档；R001 使用系统生成的知识库首页。 */
  homePageId: string | null;
  /** 收藏时间戳；null 表示未收藏。收藏列表按此倒序。 */
  favoriteAt: number | null;
  /** 最近一次打开时间，用于开始首页等入口的排序。 */
  lastOpenedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 页面树节点：parentId 为 null 表示直接挂在知识库根下。 */
export interface Page {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  /** 用户自定义图标；null 时由 UI 使用默认图标。 */
  icon: string | null;
  /** 同级内的排序序号；移动/拖拽后重编为 0..n-1（见 pageTree.movePage）。 */
  position: number;
  /** 收藏时间戳；null 表示未收藏。删除后保留但不展示。 */
  favoriteAt: number | null;
  /** 最近浏览时间；null 表示从未打开，「浏览过」列表会排除。 */
  lastOpenedAt: number | null;
  /** 软删除时间戳；非 null 即在回收站中，恢复时清空。 */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 文档正文：与 Page 一对一，pageId 即主键。 */
export interface DocumentContent {
  pageId: string;
  /** 所属知识库（R004 阶段 5）：会话加载按工作区索引直取，不再全表扫描。 */
  workspaceId: string;
  /** Tiptap JSON，唯一编辑真相。 */
  contentJson: unknown;
  /** 纯文本快照，仅用于搜索与 Markdown 导出，不参与编辑。 */
  textSnapshot: string;
  /**
   * 乐观并发版本令牌（R005 阶段 3）：不透明 ContentVersionToken，
   * 每次落盘由实现生成新令牌，保存时校验 expectedVersion。
   * 应用层不得解析；Web IndexedDB 内部仍存 number，读写边界转换为 "idb:N"。
   */
  version: ContentVersionToken;
  updatedAt: number;
}

/**
 * 版本来源：interval 间隔自动版本 / before-restore 恢复前自动备份 / manual 手动创建。
 * 只有 interval 版本受间隔与数量上限约束（见 revisions.ts）。
 */
export type RevisionReason = "interval" | "before-restore" | "manual";

/** 本地版本历史条目（R001 §8.3），保留与正文相同的 JSON + 快照两份内容。 */
export interface DocumentRevision {
  id: string;
  pageId: string;
  contentJson: unknown;
  textSnapshot: string;
  createdAt: number;
  reason: RevisionReason;
}

/**
 * 附件元数据（R005 阶段 5）：领域实体只含元数据，不再携带 Blob。
 * 二进制以平台无关的 Uint8Array 经 BinaryAttachment 与 AssetStore port
 * 传递（见 repositories.ts）；Blob 只存在于 Web 适配边界（platform/web
 * 由字节重建 Blob 以创建 Object URL / 触发下载）。字段命名保持 pageId
 * （对应规格 AssetMetadata.documentId），避免无谓的存储迁移。
 */
export interface Attachment {
  id: string;
  pageId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

/** 附件元数据 + 二进制字节（对应规格 BinaryAsset）。 */
export interface BinaryAttachment {
  attachment: Attachment;
  data: Uint8Array;
}

/** 工作区内可复用的标签定义。 */
export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
}

/** 页面与标签的多对多关联；删除标签时关联一并解除。 */
export interface PageTag {
  pageId: string;
  tagId: string;
  /** 所属知识库（R004 阶段 5）：冗余自页面，供工作区索引直取。 */
  workspaceId: string;
}

export type ThemeName = "light" | "dark";

/**
 * AI 服务配置（OpenAI 兼容接口）。
 * 只存 IndexedDB，不进入日志、分析或错误上报（见 docs/architecture.md 安全要求）。
 */
export interface AIConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

/** 浏览器本地偏好：单例记录，id 固定为 "preferences"。 */
export interface Preferences {
  id: "preferences";
  theme: ThemeName;
  sidebarWidth: number;
  aiConfig: AIConfig | null;
  /** 上次路由（AppRoute 的 JSON 序列化）；null 表示首次安装，进入开始首页。 */
  lastRoute: string | null;
}

/** 回收站记录：恢复页面时据此回到原父级（原父级不可用时回根，见 PageRepository.restore）。 */
export interface TrashRecord {
  pageId: string;
  deletedAt: number;
  originalParentId: string | null;
}

/** 全局搜索命中结果（见 search.searchPages）。 */
export interface SearchResult {
  pageId: string;
  title: string;
  /** 正文命中时的上下文片段；仅标题命中时为空字符串。 */
  snippet: string;
}

/** 侧栏默认宽度（px）。 */
export const DEFAULT_SIDEBAR_WIDTH = 224;

/** 首次安装或偏好数据损坏时的回退值。 */
export const DEFAULT_PREFERENCES: Preferences = {
  id: "preferences",
  theme: "light",
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  aiConfig: null,
  lastRoute: null,
};
