/**
 * 文档提交服务（R004 阶段 2）：所有正文写入完成后的公共动作单点。
 *
 * - commit：保存协调器的正文提交通道——落盘 + 搜索索引同步（INV-05），
 *   实时编辑与外部内容替换共享同一提交语义；
 * - createWithContent / replaceContent：非编辑器路径的原子文档写
 *   （INV-04），写入成功后同步搜索索引并记录开发诊断。
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

/** 保存协调器依赖的窄提交接口（R004 §2.3）。 */
export interface DocumentContentCommitter {
  commit(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
  ): Promise<{ savedAt: number }>;
}

export class DocumentCommitService implements DocumentContentCommitter {
  constructor(
    private readonly deps: {
      content: ContentRepository;
      documentWrite: DocumentWriteRepository;
      revisions: RevisionRepository;
      searchIndex: SearchIndexService;
    },
  ) {}

  /** 正文提交：落盘 + 搜索索引增量同步（INV-05 单点保证）。 */
  async commit(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
  ): Promise<{ savedAt: number }> {
    await this.deps.content.save(pageId, contentJson, textSnapshot);
    const savedAt = Date.now();
    this.deps.searchIndex.updateText(pageId, textSnapshot, savedAt);
    return { savedAt };
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
    increment("document-commit", "replace");
    return content;
  }

  /**
   * 版本恢复（R004 §3.5，INV-06）：先把当前内容存为 before-restore 版本，
   * 再经调用方提供的协调器提交通道串行落盘目标版本——与编辑器实时保存
   * 同一串行队列，旧防抖保存不可能覆盖恢复结果；搜索索引随提交同步。
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
