/**
 * 文档查询服务（R005 批次 1）：正文与版本的只读查询入口。
 *
 * 批次 2 起承接全部组件侧直查：getContent（DocumentEditor/MainArea）、
 * listRevisions（VersionPanel/SettingsPanel）、listAllContents
 * （WorkspaceHome 总字数统计需要跨知识库正文全集）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type {
  ContentRepository,
  RevisionRepository,
} from "../../domain/repositories";
import type { DocumentContent, DocumentRevision } from "../../domain/types";

export class DocumentQueryService {
  constructor(
    private readonly deps: {
      content: ContentRepository;
      revisions: RevisionRepository;
    },
  ) {}

  /** 按 pageId 取正文；不存在时返回 undefined。 */
  getContent(pageId: string): Promise<DocumentContent | undefined> {
    return this.deps.content.get(pageId);
  }

  /** 按创建时间倒序列出页面版本（损坏记录由仓储跳过）。 */
  listRevisions(pageId: string): Promise<DocumentRevision[]> {
    return this.deps.revisions.listByPage(pageId);
  }

  /** 跨知识库全部正文（知识库首页统计等全局视图专用）。 */
  listAllContents(): Promise<DocumentContent[]> {
    return this.deps.content.listAll();
  }
}
