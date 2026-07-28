/**
 * DocumentWriteRepository 契约套件（R004 阶段 2）：
 * IndexedDB 与内存实现共用同一组行为断言，保证两实现语义一致。
 * 覆盖：原子创建（INV-04）、失败回滚、入参与正文白名单校验。
 */
import { describe, expect, it } from "vitest";
import { isDomainError } from "../domain/errors";
import type {
  ContentRepository,
  DocumentWriteRepository,
  PageRepository,
  WorkspaceRepository,
} from "../domain/repositories";

export interface DocumentWriteContractDeps {
  workspace: WorkspaceRepository;
  page: PageRepository;
  content: ContentRepository;
  documentWrite: DocumentWriteRepository;
}

const VALID_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "初始正文" }] },
  ],
};

/** 不在白名单内的节点类型：校验必须拒绝。 */
const INVALID_DOC = {
  type: "doc",
  content: [{ type: "evil-node", attrs: { onload: "x" } }],
};

export function describeDocumentWriteContract(
  name: string,
  makeDeps: () => DocumentWriteContractDeps | Promise<DocumentWriteContractDeps>,
): void {
  describe(`DocumentWriteRepository 契约（${name}）`, () => {
    it("createWithContent 原子创建页面与初始正文", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.documentWrite.createWithContent({
        workspaceId: ws.id,
        parentId: null,
        title: "原子文档",
        contentJson: VALID_DOC,
        textSnapshot: "初始正文",
      });

      expect(page.kind).toBe("document");
      const stored = await deps.content.get(page.id);
      expect(stored?.textSnapshot).toBe("初始正文");
      expect(stored?.contentJson).toEqual(VALID_DOC);
      // 页面列表立即可见。
      const pages = await deps.page.listByWorkspace(ws.id);
      expect(pages.map((p) => p.id)).toContain(page.id);
    });

    it("正文 JSON 未通过白名单校验：不写入页面也不写入正文", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const before = await deps.page.listByWorkspace(ws.id);

      await expect(
        deps.documentWrite.createWithContent({
          workspaceId: ws.id,
          parentId: null,
          title: "坏文档",
          contentJson: INVALID_DOC,
          textSnapshot: "",
        }),
      ).rejects.toSatisfy((e) => isDomainError(e, "CORRUPTED_DOCUMENT"));
      expect(await deps.page.listByWorkspace(ws.id)).toEqual(before);
    });

    it("知识库不存在：抛 WORKSPACE_NOT_FOUND 且无写入", async () => {
      const deps = await makeDeps();
      // IndexedDB 实现首次列表会惰性写入 seed 数据，断言失败前后页面数不变。
      const before = (await deps.page.listAll()).length;
      await expect(
        deps.documentWrite.createWithContent({
          workspaceId: "ws-missing",
          parentId: null,
          title: "孤儿文档",
          contentJson: VALID_DOC,
          textSnapshot: "初始正文",
        }),
      ).rejects.toSatisfy((e) => isDomainError(e, "WORKSPACE_NOT_FOUND"));
      expect((await deps.page.listAll()).length).toBe(before);
    });

    it("父页面非法（不存在/跨知识库/回收站）：事务回滚无写入", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库A");
      const other = await deps.workspace.create("知识库B");
      const foreign = await deps.page.create({
        workspaceId: other.id,
        parentId: null,
        kind: "document",
        title: "外部页面",
      });
      const trashed = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "待删页面",
      });
      await deps.page.remove(trashed.id);
      const countBefore = (await deps.page.listByWorkspace(ws.id)).length;

      const attempt = (parentId: string) =>
        deps.documentWrite.createWithContent({
          workspaceId: ws.id,
          parentId,
          title: "子文档",
          contentJson: VALID_DOC,
          textSnapshot: "初始正文",
        });
      await expect(attempt("page-missing")).rejects.toSatisfy((e) =>
        isDomainError(e, "PARENT_NOT_FOUND"),
      );
      await expect(attempt(foreign.id)).rejects.toSatisfy((e) =>
        isDomainError(e, "CROSS_WORKSPACE_PARENT"),
      );
      await expect(attempt(trashed.id)).rejects.toSatisfy((e) =>
        isDomainError(e, "PARENT_IN_TRASH"),
      );
      // 三次失败均未产生新页面。
      expect((await deps.page.listByWorkspace(ws.id)).length).toBe(countBefore);
    });

    it("标题非法：INVALID_INPUT 且无写入", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      await expect(
        deps.documentWrite.createWithContent({
          workspaceId: ws.id,
          parentId: null,
          title: "   ",
          contentJson: VALID_DOC,
          textSnapshot: "",
        }),
      ).rejects.toSatisfy((e) => isDomainError(e, "INVALID_INPUT"));
      expect(await deps.page.listByWorkspace(ws.id)).toHaveLength(0);
    });

    it("replaceContent 覆盖正文并返回新记录", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.documentWrite.createWithContent({
        workspaceId: ws.id,
        parentId: null,
        title: "文档",
        contentJson: VALID_DOC,
        textSnapshot: "初始正文",
      });

      const next = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "替换后" }] },
        ],
      };
      const record = await deps.documentWrite.replaceContent({
        pageId: page.id,
        contentJson: next,
        textSnapshot: "替换后",
      });
      expect(record.textSnapshot).toBe("替换后");
      expect((await deps.content.get(page.id))?.contentJson).toEqual(next);
    });

    it("replaceContent 页面不存在或正文非法：抛错且不写入", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.documentWrite.createWithContent({
        workspaceId: ws.id,
        parentId: null,
        title: "文档",
        contentJson: VALID_DOC,
        textSnapshot: "初始正文",
      });

      await expect(
        deps.documentWrite.replaceContent({
          pageId: "page-missing",
          contentJson: VALID_DOC,
          textSnapshot: "x",
        }),
      ).rejects.toSatisfy((e) => isDomainError(e, "PAGE_NOT_FOUND"));
      await expect(
        deps.documentWrite.replaceContent({
          pageId: page.id,
          contentJson: INVALID_DOC,
          textSnapshot: "x",
        }),
      ).rejects.toSatisfy((e) => isDomainError(e, "CORRUPTED_DOCUMENT"));
      // 原有正文未被破坏。
      expect((await deps.content.get(page.id))?.textSnapshot).toBe("初始正文");
    });
  });
}
