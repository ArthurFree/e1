/**
 * ContentRepository 乐观并发契约套件（R004 阶段 7 §7.3）：
 * IndexedDB 与内存实现共用同一组行为断言，保证两实现语义一致。
 * 覆盖：version 递增、expectedVersion 不匹配抛 DOCUMENT_CONFLICT、
 * 存量无 version 记录的读路径归一化与首存兼容。
 */
import { describe, expect, it } from "vitest";
import { isDomainError } from "../domain/errors";
import type {
  ContentRepository,
  PageRepository,
  WorkspaceRepository,
} from "../domain/repositories";

export interface ContentSaveContractDeps {
  workspace: WorkspaceRepository;
  page: PageRepository;
  content: ContentRepository;
  /** 写入一条 R004 阶段 7 之前格式的存量正文记录（无 version 字段）。 */
  seedLegacyContent(pageId: string, workspaceId: string): Promise<void>;
}

const DOC_A = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }],
};
const DOC_B = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }],
};

export function describeContentSaveContract(
  name: string,
  makeDeps: () => ContentSaveContractDeps | Promise<ContentSaveContractDeps>,
): void {
  describe(`ContentRepository 乐观并发契约（${name}）`, () => {
    it("保存返回新版本号并递增落盘", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      // 页面创建时已写入 version 1 的空正文。
      expect((await deps.content.get(page.id))?.version).toBe(1);

      const first = await deps.content.save(page.id, DOC_A, "甲", 1);
      expect(first.version).toBe(2);
      expect(typeof first.updatedAt).toBe("number");
      expect((await deps.content.get(page.id))?.version).toBe(2);

      const second = await deps.content.save(page.id, DOC_B, "乙", 2);
      expect(second.version).toBe(3);
      const stored = await deps.content.get(page.id);
      expect(stored?.version).toBe(3);
      expect(stored?.textSnapshot).toBe("乙");
    });

    it("expectedVersion 不匹配抛 DOCUMENT_CONFLICT，且磁盘内容不被覆盖", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      await deps.content.save(page.id, DOC_A, "甲", 1);

      // 模拟另一标签页基于过期版本的保存。
      await expect(
        deps.content.save(page.id, DOC_B, "乙", 1),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
      const stored = await deps.content.get(page.id);
      expect(stored?.version).toBe(2);
      expect(stored?.textSnapshot).toBe("甲");
    });

    it("存量无 version 记录：读路径归一化为 0，首存 expectedVersion 0 落 1", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      await deps.seedLegacyContent(page.id, ws.id);

      // 读路径把缺失 version 视为 0。
      expect((await deps.content.get(page.id))?.version).toBe(0);
      // 基于 version 0 的首存成功并落 1。
      const saved = await deps.content.save(page.id, DOC_A, "甲", 0);
      expect(saved.version).toBe(1);
      expect((await deps.content.get(page.id))?.version).toBe(1);
      // 版本已推进后，过期 expectedVersion 仍然冲突。
      await expect(
        deps.content.save(page.id, DOC_B, "乙", 0),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
    });

    it("页面不存在仍抛 PAGE_NOT_FOUND（优先于版本检查）", async () => {
      const deps = await makeDeps();
      await expect(
        deps.content.save("missing-page", DOC_A, "x", 0),
      ).rejects.toSatisfy((e) => isDomainError(e, "PAGE_NOT_FOUND"));
    });
  });
}
