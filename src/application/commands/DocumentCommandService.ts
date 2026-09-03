/**
 * 文档命令服务（R005 批次 1）：文档级写编排的命令入口。
 *
 * - createWithContent：原子创建「页面 + 初始正文」（经 DocumentCommitService
 *   单点落盘 + 搜索索引同步），随后广播 page-changed（原 Provider 的广播迁入）；
 * - commit / replaceContent / restoreRevision：直接委托 DocumentCommitService
 *   （其内部已负责乐观锁、搜索索引同步与 content-saved 广播）。
 *   R005 批次 2 起全部调用方（DocumentEditor 版本恢复、MainArea 空白副本）
 *   均经本服务访问，AppServices 不再暴露 documentCommit 字段；
 * - relocateBrokenLink（R010 Stage 6 §14）：失效链接重新定位——打开源文档
 *  （经 DocumentQueryService）、重写命中链接、经同一提交通道落盘。
 *
 * 依赖经构造函数注入，不依赖 IndexedDB 具体实现。
 */
import type {
  CreateDocumentWithContentInput,
  ReplaceDocumentContentInput,
} from "../../domain/repositories";
import type {
  ContentVersionToken,
  DocumentContent,
  Page,
} from "../../domain/types";
import { DomainError } from "../../domain/errors";
import { jsonToText } from "../../editor/markdown";
import { relativeVaultPath } from "../../../shared/markdown/relativePath";
import type { DocumentCommitService } from "../services/DocumentCommitService";
import type { DocumentQueryService } from "../queries/DocumentQueryService";
import type { ChangeChannel } from "../services/ChangeChannel";
import { rewriteLinkHref } from "../links/rewriteLinkHref";

/** 版本恢复入参（与 DocumentCommitService.restoreRevision 同构）。 */
export interface RestoreRevisionCommandInput {
  pageId: string;
  current: { contentJson: unknown; textSnapshot: string };
  target: { contentJson: unknown; textSnapshot: string };
  commit: (contentJson: unknown, textSnapshot: string) => Promise<unknown>;
}

/** 失效链接重新定位入参（R010 Stage 6 §14）。 */
export interface RelocateBrokenLinkInput {
  /** 失效链接所在的源文档页面 id。 */
  sourcePageId: string;
  /** 索引报告的原始 href（精确匹配重写目标；空串为节点引用，不支持）。 */
  oldHref: string;
  /** 用户选择的新目标页面 id。 */
  newTargetPageId: string;
}

export class DocumentCommandService {
  constructor(
    private readonly deps: {
      documentCommit: DocumentCommitService;
      /**
       * 文档查询服务（R010 Stage 6）：relocateBrokenLink 经 openDocument
       * 读取源文档正文与路径上下文。与 queries.document 共享同一实例。
       */
      documentQueries: DocumentQueryService;
      /** 变更广播频道（R004 §7.2；R005 阶段 8 §8.3 ChangeChannel port）；可选，缺省不广播。 */
      syncChannel?: ChangeChannel;
    },
  ) {}

  /** 原子创建文档（页面 + 初始正文）并广播 page-changed。 */
  async createWithContent(
    input: CreateDocumentWithContentInput,
  ): Promise<Page> {
    const page = await this.deps.documentCommit.createWithContent(input);
    this.deps.syncChannel?.publish({
      type: "page-changed",
      workspaceId: input.workspaceId,
      pageId: page.id,
    });
    return page;
  }

  /** 正文提交：乐观锁落盘 + 搜索索引同步（委托 DocumentCommitService）。 */
  commit(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
    expectedVersion: ContentVersionToken,
  ): Promise<{ savedAt: number; version: ContentVersionToken }> {
    return this.deps.documentCommit.commit(
      pageId,
      contentJson,
      textSnapshot,
      expectedVersion,
    );
  }

  /** 覆盖正文（导入/模板等外部路径；委托 DocumentCommitService）。 */
  replaceContent(input: ReplaceDocumentContentInput): Promise<DocumentContent> {
    return this.deps.documentCommit.replaceContent(input);
  }

  /** 版本恢复（INV-06 串行化编排；委托 DocumentCommitService）。 */
  restoreRevision(input: RestoreRevisionCommandInput): Promise<void> {
    return this.deps.documentCommit.restoreRevision(input);
  }

  /**
   * 失效链接重新定位（R010 Stage 6 §14）：把源文档中 href 精确等于
   * oldHref 的全部链接改写为指向新目标页面的相对路径，经统一提交通道落盘。
   *
   * 语义决策：
   * - 以磁盘内容为准（queries.document.openDocument 读取），不触碰编辑器
   *   内存态；若源文档正在编辑器中打开且有未保存修改，本次落盘基于磁盘
   *   版本推进，编辑器的下一次自动保存会按既有乐观锁语义撞
   *   DOCUMENT_CONFLICT 并弹出冲突面板（多标签页冲突同口径），
   *   绝不静默覆盖未保存内容；
   * - 保存走 documentCommit.commit（与编辑器实时保存同一通道，
   *   搜索/链接索引同步与 content-saved 广播随之发生），expectedVersion
   *   取打开时的 versionToken，乐观锁照旧；
   * - 重写范围为该文档内全部 href 精确匹配（见 rewriteLinkHref 头注）；
   * - 新 href 保留原链接的 #锚点片段（页面换了，用户书写的锚点意图不丢）。
   */
  async relocateBrokenLink(
    input: RelocateBrokenLinkInput,
  ): Promise<{ rewritten: number; newHref: string }> {
    const { sourcePageId, oldHref, newTargetPageId } = input;
    if (oldHref.trim() === "") {
      // internalLink/mention 节点引用的 href 恒为 ""，DocumentLink 不携带
      // 节点身份（stale target id），无法确定性匹配——本阶段不支持，
      // 面板侧同步禁用入口。
      throw new DomainError(
        "NOT_IMPLEMENTED",
        "页面引用（@ 提及）链接暂不支持重新定位。",
      );
    }
    const { documentQueries } = this.deps;
    const source = await documentQueries.openDocument(sourcePageId);
    if (!source) {
      throw new DomainError("PAGE_NOT_FOUND", "源文档不存在或已被删除。");
    }
    if (source.access === "read-only") {
      // 兼容模式只读文档（含无法无损往返的语法）：整篇重写序列化会丢
      // 信息，保护性拒绝——不写比静默有损安全。
      throw new DomainError(
        "INVALID_INPUT",
        "该文档正以兼容模式只读打开，不能改写其中的链接。",
      );
    }
    const sourcePath = source.source.relativePath;
    if (!sourcePath) {
      throw new DomainError(
        "DOCUMENT_SOURCE_CONTEXT_REQUIRED",
        "缺少源文档的 Vault 路径，无法计算相对链接。",
      );
    }
    const target = await documentQueries.openDocument(newTargetPageId);
    if (!target) {
      throw new DomainError("PAGE_NOT_FOUND", "目标页面不存在或已被删除。");
    }
    const targetPath = target.source.relativePath;
    if (!targetPath) {
      throw new DomainError(
        "DOCUMENT_SOURCE_CONTEXT_REQUIRED",
        "缺少目标页面的 Vault 路径，无法计算相对链接。",
      );
    }
    const fragment = oldHref.includes("#")
      ? oldHref.slice(oldHref.indexOf("#"))
      : "";
    const newHref = relativeVaultPath(sourcePath, targetPath) + fragment;
    const { document, rewritten } = rewriteLinkHref(
      source.content.contentJson,
      oldHref,
      newHref,
    );
    if (rewritten === 0) {
      throw new DomainError(
        "INVALID_INPUT",
        "源文档中未找到该链接，可能已被修改，请刷新后重试。",
      );
    }
    await this.deps.documentCommit.commit(
      sourcePageId,
      document,
      jsonToText(document),
      source.source.versionToken,
    );
    return { rewritten, newHref };
  }
}
