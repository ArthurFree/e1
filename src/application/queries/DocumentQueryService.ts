/**
 * 文档查询服务（R005 批次 1）：正文与版本的只读查询入口。
 *
 * 批次 2 起承接全部组件侧直查：getContent（DocumentEditor/MainArea）、
 * listRevisions（VersionPanel/SettingsPanel）、listAllContents
 * （WorkspaceHome 总字数统计需要跨知识库正文全集）。
 * R006-C3（FR-17/18）：openDocument 为文档打开主入口——返回正文 +
 * 访问级别（editable/read-only）+ Markdown 兼容性 + 来源信息；
 * Desktop 正文仓储经 DocumentOpenCapable 扩展提供真实打开语义。
 * R006-C4（FR-02）：扩展 writePolicy——区分运行时持久化能力与当前文档写入策略。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type {
  ContentRepository,
  RevisionRepository,
} from "../../domain/repositories";
import type {
  ContentVersionToken,
  DocumentContent,
  DocumentRevision,
} from "../../domain/types";
import type { UnsupportedMarkdownFeature } from "../../editor/markdown/types";
import {
  DEFAULT_WRITE_POLICY,
  type DocumentWritePolicy,
} from "./documentWritePolicy";

export type { DocumentWritePolicy } from "./documentWritePolicy";

/**
 * 文档打开访问级别（R006-C3 FR-17/19/21）：
 * - editable：可编辑（是否真实持久化由 capabilities.documentPersistence 决定）；
 * - read-only：保护性只读——Markdown 含有损风险语法时 Desktop 默认进入，
 *   编辑器拒绝一切修改，只允许选择/复制/滚动/目录跳转等阅读操作。
 */
export type DocumentAccess = "editable" | "read-only";

/**
 * 文档打开结果（R006-C3 FR-17 + R006-C4 FR-02）：区分持久化内容与会话打开状态。
 * content 是唯一的正文载体；access/writePolicy/compatibility/source 只在「打开」
 * 这一刻由读取通道判定（Desktop 来自 note.read + MarkdownCodec，Web 为固定默认值）。
 */
export interface DocumentOpenResult {
  content: DocumentContent;
  access: DocumentAccess;
  /** R006-C4：当前文档写入策略（与 capabilities.documentPersistence 正交）。 */
  writePolicy: DocumentWritePolicy;
  compatibility: {
    /** true = 解析检出无法无损往返的语法（与 unsupported.length > 0 等价）。 */
    lossy: boolean;
    unsupported: UnsupportedMarkdownFeature[];
  };
  source: {
    /** Desktop：Vault 内相对路径；Web 无（undefined）。 */
    relativePath?: string;
    /** 读取时的版本令牌（Web 为 idb:N，Desktop 为 sha256:<hash>）。 */
    versionToken: ContentVersionToken;
    modifiedAt?: number;
    sizeBytes?: number;
  };
}

/**
 * 可选扩展接口（R006-C3 FR-18）：能承载「打开语义」的正文仓储（Desktop）
 * 额外实现本方法；Web 仓储没有它，openDocument 走默认包装。
 */
export interface DocumentOpenCapable {
  openDocument(pageId: string): Promise<DocumentOpenResult>;
}

/** 类型守卫：正文仓储是否实现了打开语义扩展。 */
function isDocumentOpenCapable(
  repo: ContentRepository,
): repo is ContentRepository & DocumentOpenCapable {
  return (
    typeof (repo as Partial<DocumentOpenCapable>).openDocument === "function"
  );
}

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

  /**
   * 打开文档（R006-C3 FR-18）：返回正文 + 访问级别 + 兼容性 + 来源信息。
   * - 仓储实现 DocumentOpenCapable（Desktop）时委托其真实打开语义——
   *   失败（文件不存在/过大/权限/编码/I/O）以 DomainError 抛出；
   * - 否则（Web/内存）默认包装：access 恒 editable、lossy 恒 false；
   *   正文不存在返回 null，沿用「无正文 = 新文档」语义（MainArea 以空文档兜底）。
   */
  async openDocument(pageId: string): Promise<DocumentOpenResult | null> {
    if (isDocumentOpenCapable(this.deps.content)) {
      return this.deps.content.openDocument(pageId);
    }
    const content = await this.deps.content.get(pageId);
    if (!content) return null;
    return {
      content,
      access: "editable",
      writePolicy: DEFAULT_WRITE_POLICY,
      compatibility: { lossy: false, unsupported: [] },
      source: { versionToken: content.version, modifiedAt: content.updatedAt },
    };
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
