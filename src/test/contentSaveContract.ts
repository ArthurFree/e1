/**
 * ContentRepository 乐观并发契约套件（R004 阶段 7 §7.3；R005 阶段 3 起
 * 版本改为不透明 ContentVersionToken）：IndexedDB 与内存实现共用同一组
 * 行为断言，保证两实现语义一致。
 *
 * 覆盖（全部为令牌语义，不假设令牌可解析为数字、不假设两实现编码相同）：
 * - 首次保存返回新令牌，顺序保存令牌单调变化（只断言「不同」，不断言格式）；
 * - 过期/异源（非本实现编码）令牌抛 DOCUMENT_CONFLICT；
 * - 存量无 version 记录的读路径归一化与 INITIAL_CONTENT_VERSION_TOKEN 首存兼容。
 */
import { describe, expect, it } from "vitest";
import { isDomainError } from "../domain/errors";
import type {
  ContentRepository,
  PageRepository,
  WorkspaceRepository,
} from "../domain/repositories";
import { INITIAL_CONTENT_VERSION_TOKEN } from "../domain/types";

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
    it("保存返回新版本令牌，顺序保存令牌逐次变化并落盘", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      // 页面创建时已写入首版空正文：读出当前令牌作为首次保存的 expectedVersion。
      const created = (await deps.content.get(page.id))!.version;
      expect(typeof created).toBe("string");
      expect(created).not.toBe(INITIAL_CONTENT_VERSION_TOKEN);

      const first = await deps.content.save(page.id, DOC_A, "甲", created);
      // 令牌不透明：只断言是字符串、与上一令牌不同。
      expect(typeof first.version).toBe("string");
      expect(first.version).not.toBe(created);
      expect(typeof first.updatedAt).toBe("number");
      expect((await deps.content.get(page.id))?.version).toBe(first.version);

      const second = await deps.content.save(
        page.id,
        DOC_B,
        "乙",
        first.version,
      );
      expect(second.version).not.toBe(first.version);
      const stored = await deps.content.get(page.id);
      expect(stored?.version).toBe(second.version);
      expect(stored?.textSnapshot).toBe("乙");
    });

    it("过期令牌抛 DOCUMENT_CONFLICT，且磁盘内容不被覆盖", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      const created = (await deps.content.get(page.id))!.version;
      const first = await deps.content.save(page.id, DOC_A, "甲", created);

      // 模拟另一标签页基于过期令牌的保存。
      await expect(
        deps.content.save(page.id, DOC_B, "乙", created),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
      const stored = await deps.content.get(page.id);
      expect(stored?.version).toBe(first.version);
      expect(stored?.textSnapshot).toBe("甲");
    });

    it("异源令牌（非本实现编码）一律视为冲突，绝不解析透传", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      // 其他实现的编码（如 Desktop 的 sha256 令牌）对本实现无意义：
      // 无法对应持久化状态，必须按冲突处理而不是猜测。
      await expect(
        deps.content.save(page.id, DOC_A, "甲", "sha256:abc123"),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
      // 畸形令牌同样冲突。
      await expect(
        deps.content.save(page.id, DOC_A, "甲", "not-a-version"),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
    });

    it("存量无 version 记录：读路径归一化为初始令牌，INITIAL_CONTENT_VERSION_TOKEN 可首存", async () => {
      const deps = await makeDeps();
      const ws = await deps.workspace.create("知识库");
      const page = await deps.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      await deps.seedLegacyContent(page.id, ws.id);

      // 读路径把缺失 version 视为初始版本令牌（实现自定义编码，只断言是字符串）。
      const legacyToken = (await deps.content.get(page.id))!.version;
      expect(typeof legacyToken).toBe("string");
      // 初始令牌（空串）表示「应无既有版本」：对存量无 version 记录首存成功。
      const saved = await deps.content.save(
        page.id,
        DOC_A,
        "甲",
        INITIAL_CONTENT_VERSION_TOKEN,
      );
      expect((await deps.content.get(page.id))?.version).toBe(saved.version);
      // 版本已推进后，初始令牌与旧读令牌均过期，仍然冲突。
      await expect(
        deps.content.save(page.id, DOC_B, "乙", INITIAL_CONTENT_VERSION_TOKEN),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
      await expect(
        deps.content.save(page.id, DOC_B, "乙", legacyToken),
      ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));
    });

    it("页面不存在仍抛 PAGE_NOT_FOUND（优先于版本检查）", async () => {
      const deps = await makeDeps();
      await expect(
        deps.content.save(
          "missing-page",
          DOC_A,
          "x",
          INITIAL_CONTENT_VERSION_TOKEN,
        ),
      ).rejects.toSatisfy((e) => isDomainError(e, "PAGE_NOT_FOUND"));
    });
  });
}
