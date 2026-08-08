/**
 * 知识库查询服务（R005 批次 1）：知识库/会话/页面/标签读编排从
 * WorkspaceProvider 下沉；服务只返回数据并维护搜索索引，
 * requestId 过期保护与 dispatch 仍留在状态层。
 *
 * - loadSession：原子会话加载（WorkspaceSessionService）+ 搜索索引全量构建
 *   （原 Provider loadSession 中的索引构建迁入）；
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
import type { SearchIndexService } from "../services/SearchIndexService";
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
      searchIndex: SearchIndexService;
    },
  ) {}

  /** 全部知识库列表。 */
  listWorkspaces(): Promise<Workspace[]> {
    return this.deps.workspace.list();
  }

  /** 原子加载知识库会话数据并（重）构建工作区搜索索引。 */
  async loadSession(workspaceId: string): Promise<WorkspaceSessionData> {
    const data = await this.deps.session.load(workspaceId);
    // 搜索索引随会话加载构建（R003 阶段 7；R005 批次 1 从 Provider 迁入）。
    this.deps.searchIndex.build(workspaceId, data.pages, data.contents);
    return data;
  }

  /** 刷新工作区页面镜像并同步搜索索引元数据。 */
  async loadPages(workspaceId: string): Promise<Page[]> {
    const pages = await this.deps.page.listByWorkspace(workspaceId);
    // 页面写操作后同步搜索索引元数据（R003 阶段 7）。
    this.deps.searchIndex.syncPages(workspaceId, pages);
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
