/**
 * 文档命令服务（R005 批次 1）：文档级写编排的命令入口。
 *
 * - createWithContent：原子创建「页面 + 初始正文」（经 DocumentCommitService
 *   单点落盘 + 搜索索引同步），随后广播 page-changed（原 Provider 的广播迁入）；
 * - commit / replaceContent / restoreRevision：直接委托 DocumentCommitService
 *   （其内部已负责乐观锁、搜索索引同步与 content-saved 广播）。
 *   R005 批次 2 起全部调用方（DocumentEditor 版本恢复、MainArea 空白副本）
 *   均经本服务访问，AppServices 不再暴露 documentCommit 字段。
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
import type { DocumentCommitService } from "../services/DocumentCommitService";
import type { SyncChannelService } from "../services/SyncChannelService";

/** 版本恢复入参（与 DocumentCommitService.restoreRevision 同构）。 */
export interface RestoreRevisionCommandInput {
  pageId: string;
  current: { contentJson: unknown; textSnapshot: string };
  target: { contentJson: unknown; textSnapshot: string };
  commit: (contentJson: unknown, textSnapshot: string) => Promise<unknown>;
}

export class DocumentCommandService {
  constructor(
    private readonly deps: {
      documentCommit: DocumentCommitService;
      /** 跨标签页同步频道（R004 §7.2）；可选，缺省不广播。 */
      syncChannel?: SyncChannelService;
    },
  ) {}

  /** 原子创建文档（页面 + 初始正文）并广播 page-changed。 */
  async createWithContent(
    input: CreateDocumentWithContentInput,
  ): Promise<Page> {
    const page = await this.deps.documentCommit.createWithContent(input);
    this.deps.syncChannel?.post({
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
}
