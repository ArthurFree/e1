/**
 * 文档命令服务（R005 批次 1）：文档级写编排的命令入口。
 *
 * - createWithContent：原子创建「页面 + 初始正文」（经 DocumentCommitService
 *   单点落盘 + 搜索索引同步），随后广播 page-changed（原 Provider 的广播迁入）；
 * - commit / replaceContent / restoreRevision：直接委托 DocumentCommitService
 *   （其内部已负责乐观锁、搜索索引同步与 content-saved 广播）。
 *   R005 批次 2 起全部调用方（DocumentEditor 版本恢复、MainArea 空白副本）
 *   均经本服务访问，AppServices 不再暴露 documentCommit 字段；
 * - createManualRevision（R012 Stage 3，需求 §22）：手动版本捕获入口，
 *   绕过 interval 节流，失败抛 DomainError（不走 maintenance warning 降级）；
 * - relocateBrokenLink（R010 Stage 6 §14）：失效链接重新定位——打开源文档
 *  （经 DocumentQueryService）、重写命中链接、经同一提交通道落盘。
 *
 * 依赖经构造函数注入，不依赖 IndexedDB 具体实现。
 */
import type {
  CreateDocumentWithContentInput,
  ReplaceDocumentContentInput,
  RevisionRepository,
} from "../../domain/repositories";
import type {
  ContentVersionToken,
  DocumentContent,
  Page,
  RevisionSummary,
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
      /**
       * 版本历史仓储（R012 Stage 3）：手动版本捕获入口。
       * Desktop 实现（DesktopRevisionRepository）的 add 会忽略传入的
       * contentJson/textSnapshot，由 Main 重读磁盘 capture（REV-02）。
       */
      revisions: RevisionRepository;
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
   * 手动创建版本快照（R012 Stage 3，需求 §22「手动版本」）。
   *
   * 契约：
   * - **调用方负责先 flush 未完成保存且确认保存成功**——本方法不触发也不
   *   等待正文落盘；flush 发生 conflict / lossy / IO error 时不得调用
   *  （否则会产生与编辑器状态不一致的手动版本）。Stage 5 的 VersionPanel
   *   「创建版本」按钮按 flush → 成功后调本方法 的顺序接线；
   * - contentJson/textSnapshot 为调用方传入的当前编辑器状态；Desktop 实现
   *   会忽略它们、以磁盘 raw Markdown body 为准（REV-02），Web/内存实现
   *   按传入内容落快照；
   * - 绕过 interval 节流（不经 shouldCreateIntervalRevision）：手动版本
   *   不受 5 分钟间隔限制，也不进入自动裁剪范围（§26）；
   * - **失败必须让调用方感知**：已映射的 DomainError 原样透传，未识别错误
   *   统一包装为 DomainError("REVISION_CAPTURE_FAILED")——不走
   *   SaveCoordinator 的 maintenance warning 降级（§43 手动 Snapshot 失败模型）。
   *
   * @returns 新快照摘要；与最新快照内容一致去重命中时返回 null（非失败，
   *   UI 可据此提示「内容与当前版本一致」）。
   */
  async createManualRevision(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
  ): Promise<RevisionSummary | null> {
    try {
      return await this.deps.revisions.add(
        pageId,
        contentJson,
        textSnapshot,
        "manual",
      );
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(
        "REVISION_CAPTURE_FAILED",
        "创建版本失败，请稍后重试。",
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
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
