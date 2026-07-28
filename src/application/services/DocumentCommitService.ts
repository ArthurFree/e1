/**
 * 文档提交服务（R004 阶段 2）：所有正文写入完成后的公共动作单点。
 *
 * - commit：保存协调器的正文提交通道——落盘 + 搜索索引同步（INV-05），
 *   实时编辑与外部内容替换共享同一提交语义；R004 阶段 7 起携带
 *   expectedVersion 乐观锁，磁盘版本不匹配时抛 DOCUMENT_CONFLICT；
 * - createWithContent / replaceContent：非编辑器路径的原子文档写
 *   （INV-04），写入成功后同步搜索索引并记录开发诊断。
 *
 * commit / replaceContent 落盘成功后经 SyncChannelService 广播
 * content-saved（R004 §7.2）：其他标签页据此刷新镜像或提示冲突；
 * 频道带来源 tabId，本标签页不会收到自己的回声。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type {
  ContentRepository,
  CreateDocumentWithContentInput,
  DocumentWriteRepository,
  ReplaceDocumentContentInput,
  RevisionRepository,
} from "../../domain/repositories";
import type { DocumentContent, Page } from "../../domain/types";
import { increment } from "../devDiagnostics";
import type { SearchIndexService } from "./SearchIndexService";
import type { SyncChannelService } from "./SyncChannelService";

/** 保存协调器依赖的窄提交接口（R004 §2.3；R004 阶段 7 加 expectedVersion）。 */
export interface DocumentContentCommitter {
  commit(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
    expectedVersion: number,
  ): Promise<{ savedAt: number; version: number }>;
}

export class DocumentCommitService implements DocumentContentCommitter {
  constructor(
    private readonly deps: {
      content: ContentRepository;
      documentWrite: DocumentWriteRepository;
      revisions: RevisionRepository;
      searchIndex: SearchIndexService;
      /** 跨标签页同步频道（R004 §7.2）；可选，缺省不广播。 */
      syncChannel?: SyncChannelService;
    },
  ) {}

  /** 正文提交：乐观锁落盘 + 搜索索引增量同步（INV-05 单点保证）。 */
  async commit(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
    expectedVersion: number,
  ): Promise<{ savedAt: number; version: number }> {
    const { version, updatedAt } = await this.deps.content.save(
      pageId,
      contentJson,
      textSnapshot,
      expectedVersion,
    );
    this.deps.searchIndex.updateText(pageId, textSnapshot, updatedAt);
    this.deps.syncChannel?.post({ type: "content-saved", pageId, version });
    return { savedAt: updatedAt, version };
  }

  /** 原子创建文档（页面 + 初始正文）并同步搜索索引。 */
  async createWithContent(
    input: CreateDocumentWithContentInput,
  ): Promise<Page> {
    const page = await this.deps.documentWrite.createWithContent(input);
    this.deps.searchIndex.upsertPage(page);
    this.deps.searchIndex.updateText(page.id, input.textSnapshot, Date.now());
    increment("document-commit", "create");
    return page;
  }

  /** 覆盖正文（导入/模板/恢复等外部路径）并同步搜索索引。 */
  async replaceContent(
    input: ReplaceDocumentContentInput,
  ): Promise<DocumentContent> {
    const content = await this.deps.documentWrite.replaceContent(input);
    this.deps.searchIndex.updateText(
      input.pageId,
      input.textSnapshot,
      content.updatedAt,
    );
    this.deps.syncChannel?.post({
      type: "content-saved",
      pageId: input.pageId,
      version: content.version,
    });
    increment("document-commit", "replace");
    return content;
  }

  /**
   * 版本恢复（R004 §3.5，INV-06）：先把当前内容存为 before-restore 版本，
   * 再经调用方提供的协调器提交通道串行落盘目标版本——与编辑器实时保存
   * 同一串行队列，旧防抖保存不可能覆盖恢复结果；搜索索引随提交同步。
   * 恢复提交同样过乐观锁（R004 阶段 7）：磁盘版本被其他标签页推进时
   * 恢复以 DOCUMENT_CONFLICT 失败，不覆盖远端修改。
   */
  async restoreRevision(input: {
    pageId: string;
    current: { contentJson: unknown; textSnapshot: string };
    target: { contentJson: unknown; textSnapshot: string };
    commit: (contentJson: unknown, textSnapshot: string) => Promise<unknown>;
  }): Promise<void> {
    await this.deps.revisions.add(
      input.pageId,
      input.current.contentJson,
      input.current.textSnapshot,
      "before-restore",
    );
    await input.commit(input.target.contentJson, input.target.textSnapshot);
    increment("document-commit", "restore");
  }
}
