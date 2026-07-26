/**
 * 工作区会话加载服务（R003 阶段 2）：一次原子加载某知识库的完整会话数据。
 *
 * 页面、标签、页面-标签关联通过一次 Promise.all 并行读取并作为整体返回；
 * 服务只返回数据、不触碰 React 状态，由状态层决定如何提交（配合 requestId
 * 丢弃过期响应，保证 UI 永远不会看到「新知识库 + 旧页面」的混合态）。
 *
 * 仓储经构造函数注入（domain port），本模块不依赖 IndexedDB 具体实现。
 */
import type {
  ContentRepository,
  PageRepository,
  TagRepository,
} from "../../domain/repositories";
import type { DocumentContent, Page, PageTag, Tag } from "../../domain/types";

/** 一个知识库的完整会话数据：四类数据必须同批次提交到 UI。 */
export interface WorkspaceSessionData {
  workspaceId: string;
  pages: Page[];
  tags: Tag[];
  pageTags: PageTag[];
  /** 本工作区文档正文（搜索索引构建用，R003 阶段 7）。 */
  contents: DocumentContent[];
}

export interface WorkspaceSessionServiceDeps {
  pages: PageRepository;
  tags: TagRepository;
  content: ContentRepository;
}

export class WorkspaceSessionService {
  constructor(private readonly deps: WorkspaceSessionServiceDeps) {}

  /** 原子加载知识库会话数据；失败时抛错，由调用方决定错误呈现。 */
  async load(workspaceId: string): Promise<WorkspaceSessionData> {
    const [pages, tags, pageTags, allContents] = await Promise.all([
      this.deps.pages.listByWorkspace(workspaceId),
      this.deps.tags.listByWorkspace(workspaceId),
      this.deps.tags.listWorkspacePageTags(workspaceId),
      this.deps.content.listAll(),
    ]);
    // 正文按本工作区页面过滤（contents 无工作区维度）。
    const pageIds = new Set(pages.map((p) => p.id));
    const contents = allContents.filter((c) => pageIds.has(c.pageId));
    return { workspaceId, pages, tags, pageTags, contents };
  }
}
