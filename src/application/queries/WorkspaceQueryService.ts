/**
 * 知识库查询服务（R005 批次 1）：知识库/会话/页面/标签读编排从
 * WorkspaceProvider 下沉；服务只返回数据并维护搜索索引，
 * requestId 过期保护与 dispatch 仍留在状态层。
 *
 * - loadSession：原子会话加载（WorkspaceSessionService，R005 阶段 6 起
 *   不再读取正文）+ 搜索索引独立准备（prepareWorkspace 自行取数）；
 * - loadPages：页面镜像刷新 + 搜索索引 syncPages 增量同步；
 * - loadTags：标签与页面-标签关联并行加载；
 * - findPage：跨知识库单页查找（收藏视图等页面不在当前镜像时的回退查询）；
 * - listAllPages：跨知识库全部页面（活动列表/收藏/创建位置选择需要
 *   软删排除的全集，R005 批次 2 从组件侧 page.listAll 直查迁入）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type {
  PageRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import type { Page, PageTag, Tag, Workspace } from "../../domain/types";
import { increment } from "../devDiagnostics";
import type { FullTextSearchIndexPort } from "../services/SearchContract";
import type { SearchIndexPort } from "../services/SearchIndexPort";
import type {
  WorkspaceSessionData,
  WorkspaceSessionService,
} from "../services/WorkspaceSessionService";

export class WorkspaceQueryService {
  constructor(
    private readonly deps: {
      workspace: WorkspaceRepository;
      page: PageRepository;
      tag: TagRepository;
      session: WorkspaceSessionService;
      searchIndex: SearchIndexPort;
      /**
       * 全文搜索索引（可选，R008 Stage 4）：具备持久化派生索引的运行时
       * 装配（Desktop）；会话加载时后台准备，不阻断会话（§11.5）。
       */
      fullTextSearchIndex?: FullTextSearchIndexPort;
    },
  ) {}

  /** 全部知识库列表。 */
  listWorkspaces(): Promise<Workspace[]> {
    return this.deps.workspace.list();
  }

  /** 原子加载知识库会话数据并独立准备工作区搜索索引。 */
  async loadSession(workspaceId: string): Promise<WorkspaceSessionData> {
    const data = await this.deps.session.load(workspaceId);
    // 搜索索引独立准备（R005 阶段 6）：索引实现自行读取正文快照，
    // 会话数据不再携带全部正文。保持同步等待——Web 内存实现同步完成
    // 不会失败；未来异步实现（SQLite 等）可改为后台准备，失败时
    // 降级为「索引未准备」，搜索自动回退全量扫描（SearchQueryService）。
    await this.deps.searchIndex.prepareWorkspace(workspaceId);
    // 全文索引后台准备（R008 Stage 4 §11.5）：首次打开无索引 Vault 触发
    // Main 侧首建 rebuild；fire-and-forget 不阻断会话加载——building 期间
    // 搜索贡献空结果，失败仅诊断，SearchPanel 自动回退标题搜索（§20）。
    if (this.deps.fullTextSearchIndex) {
      void this.deps.fullTextSearchIndex
        .prepareWorkspace(workspaceId)
        .catch(() => increment("search-index", "fulltext-prepare-failed"));
    }
    return data;
  }

  /** 刷新工作区页面镜像并同步搜索索引元数据。 */
  async loadPages(workspaceId: string): Promise<Page[]> {
    const pages = await this.deps.page.listByWorkspace(workspaceId);
    // 页面写操作后同步搜索索引元数据（R003 阶段 7）；索引同步失败
    // 仅记录诊断——派生数据不影响页面镜像主流程（R005 阶段 6）。
    try {
      await this.deps.searchIndex.syncPages(workspaceId, pages);
    } catch {
      increment("search-index", "sync-failed");
    }
    return pages;
  }

  /** 标签与页面-标签关联并行加载。 */
  async loadTags(
    workspaceId: string,
  ): Promise<{ tags: Tag[]; pageTags: PageTag[] }> {
    const [tags, pageTags] = await Promise.all([
      this.deps.tag.listByWorkspace(workspaceId),
      this.deps.tag.listWorkspacePageTags(workspaceId),
    ]);
    return { tags, pageTags };
  }

  /** 跨知识库单页查找；不存在时返回 undefined。 */
  async findPage(pageId: string): Promise<Page | undefined> {
    const all = await this.deps.page.listAll();
    return all.find((p) => p.id === pageId);
  }

  /** 跨知识库全部页面（软删排除的全集）；活动/收藏等全局视图专用。 */
  listAllPages(): Promise<Page[]> {
    return this.deps.page.listAll();
  }
}
