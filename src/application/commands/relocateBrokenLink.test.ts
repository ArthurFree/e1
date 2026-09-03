/**
 * relocateBrokenLink 编排测试（R010 Stage 6 §14）：
 * 重写正确性（含 fragment 保留）、错误分流（找不到链接/源/目标缺失/
 * 节点引用/缺路径上下文/只读）、保存走统一提交通道且乐观锁照旧。
 *
 * 装配：内存仓储 + DocumentCommitService 真实实例；正文仓储外包一层
 * DocumentOpenCapable（openDocument 携带 relativePath 的 Desktop 语义），
 * 验证编排只依赖打开模型而非具体平台。
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentRepository } from "../../domain/repositories";
import { DomainError } from "../../domain/errors";
import type { ContentVersionToken, DocumentContent } from "../../domain/types";
import {
  createInMemoryRepositories,
  createMemoryStore,
} from "../../infrastructure/memory/repositories";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import { DocumentCommitService } from "../services/DocumentCommitService";
import { DEFAULT_WRITE_POLICY } from "../queries/documentWritePolicy";
import {
  DocumentQueryService,
  type DocumentOpenCapable,
  type DocumentOpenResult,
} from "../queries/DocumentQueryService";
import { DocumentCommandService } from "./DocumentCommandService";

const SOURCE_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "旧方案",
          marks: [{ type: "link", attrs: { href: "../old/旧方案.md" } }],
        },
        { type: "text", text: "与" },
        {
          type: "text",
          text: "无关链接",
          marks: [{ type: "link", attrs: { href: "./其他.md" } }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "又见旧方案",
          marks: [{ type: "link", attrs: { href: "../old/旧方案.md" } }],
        },
      ],
    },
  ],
};

interface TestContext {
  commands: DocumentCommandService;
  commit: DocumentCommitService;
  repos: ReturnType<typeof createInMemoryRepositories>;
  paths: Record<string, string | undefined>;
}

/** 装配测试上下文：paths 提供 pageId → vault 相对路径（缺省无路径，即 Web 语义）。 */
function makeContext(
  paths: Record<string, string | undefined> = {},
): TestContext {
  const store = createMemoryStore();
  const repos = createInMemoryRepositories(store);
  const searchIndex = new BrowserMemorySearchIndex({
    pages: repos.page,
    content: repos.content,
  });
  const commit = new DocumentCommitService({
    content: repos.content,
    documentWrite: repos.documentWrite,
    revisions: repos.revision,
    searchIndex,
  });
  // Desktop 打开语义：附 relativePath/versionToken；缺失路径时退化 Web 语义。
  // DocumentOpenCapable 的契约是不返回 null——不存在时抛 DomainError
  //（Desktop 正文仓储同口径）。
  const content: ContentRepository & DocumentOpenCapable = {
    ...repos.content,
    async openDocument(pageId): Promise<DocumentOpenResult> {
      const found = await repos.content.get(pageId);
      if (!found) {
        throw new DomainError("PAGE_NOT_FOUND", "源文档不存在或已被删除。");
      }
      return {
        content: found,
        access: "editable",
        writePolicy: DEFAULT_WRITE_POLICY,
        compatibility: { lossy: false, unsupported: [] },
        source: {
          relativePath: paths[pageId],
          versionToken: found.version,
          modifiedAt: found.updatedAt,
        },
      };
    },
  };
  const commands = new DocumentCommandService({
    documentCommit: commit,
    documentQueries: new DocumentQueryService({
      content,
      revisions: repos.revision,
    }),
  });
  return { commands, commit, repos, paths };
}

/** 覆盖正文：内存仓储建页时已预置空正文记录，保存需带当前版本令牌。 */
async function putContent(
  ctx: TestContext,
  pageId: string,
  contentJson: unknown,
  textSnapshot: string,
) {
  const existing = await ctx.repos.content.get(pageId);
  await ctx.repos.content.save(
    pageId,
    contentJson,
    textSnapshot,
    existing?.version ?? "",
  );
}

/** 建两篇文档：源文档（含两条指向 oldHref 的链接）与目标文档。 */
async function seedDocuments(ctx: TestContext) {
  const ws = await ctx.repos.workspace.create("知识库");
  const source = await ctx.repos.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "项目总结",
  });
  const target = await ctx.repos.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "新方案",
  });
  await putContent(ctx, source.id, SOURCE_DOC, "旧方案");
  await putContent(ctx, target.id, { type: "doc", content: [] }, "");
  ctx.paths[source.id] = "docs/项目总结.md";
  ctx.paths[target.id] = "archive/新方案.md";
  return { ws, source, target };
}

describe("relocateBrokenLink", () => {
  it("重写全部命中链接为新目标的相对路径，经统一提交通道落盘", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    const commitSpy = vi.spyOn(ctx.commit, "commit");
    const before = await ctx.repos.content.get(source.id);

    const result = await ctx.commands.relocateBrokenLink({
      sourcePageId: source.id,
      oldHref: "../old/旧方案.md",
      newTargetPageId: target.id,
    });

    // docs/项目总结.md → archive/新方案.md 的相对路径。
    expect(result).toEqual({ rewritten: 2, newHref: "../archive/新方案.md" });
    const saved = await ctx.repos.content.get(source.id);
    const json = JSON.stringify(saved?.contentJson);
    expect(json).not.toContain("../old/旧方案.md");
    expect((json.match(/archive\/新方案\.md/g) ?? []).length).toBe(2);
    // 其他链接与文本不动。
    expect(json).toContain("./其他.md");
    expect(json).toContain("旧方案");
    // 保存走统一提交通道（commit），expectedVersion 为打开时的 versionToken。
    expect(commitSpy).toHaveBeenCalledTimes(1);
    const [pageId, , , expectedVersion] = commitSpy.mock.calls[0]!;
    expect(pageId).toBe(source.id);
    expect(expectedVersion).toBe(before?.version);
    // 落盘后版本推进、textSnapshot 同步重算。
    expect(saved?.version).not.toBe(before?.version);
    expect(saved?.textSnapshot).toContain("旧方案");
  });

  it("保留原 href 的 #锚点片段", async () => {
    const ctx = makeContext();
    const { ws, source, target } = await seedDocuments(ctx);
    const withAnchor = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "旧方案",
              marks: [
                { type: "link", attrs: { href: "../old/旧方案.md#第二节" } },
              ],
            },
          ],
        },
      ],
    };
    const page = await ctx.repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "带锚点",
    });
    await putContent(ctx, page.id, withAnchor, "旧方案");
    ctx.paths[page.id] = "docs/带锚点.md";

    const result = await ctx.commands.relocateBrokenLink({
      sourcePageId: page.id,
      oldHref: "../old/旧方案.md#第二节",
      newTargetPageId: target.id,
    });
    expect(result.newHref).toBe("../archive/新方案.md#第二节");
    expect(source.id).not.toBe(page.id);
  });

  it("文档中找不到该链接时报错且不写入", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    const commitSpy = vi.spyOn(ctx.commit, "commit");

    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "./不存在.md",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(commitSpy).not.toHaveBeenCalled();
    const saved = await ctx.repos.content.get(source.id);
    expect(JSON.stringify(saved?.contentJson)).toContain("../old/旧方案.md");
  });

  it("源文档或目标页面不存在时抛 PAGE_NOT_FOUND", async () => {
    const ctx = makeContext();
    const { target } = await seedDocuments(ctx);
    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: "ghost",
        oldHref: "../old/旧方案.md",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
    const { source } = await seedDocuments(ctx);
    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "../old/旧方案.md",
        newTargetPageId: "ghost",
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("空 href（internalLink/mention 节点引用）诚实拒绝", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("缺少 Vault 路径上下文（Web 语义）时报 DOCUMENT_SOURCE_CONTEXT_REQUIRED", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    // 移除路径上下文，模拟无 vault 映射的运行时。
    ctx.paths[source.id] = undefined;
    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "../old/旧方案.md",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_CONTEXT_REQUIRED" });
  });

  it("乐观锁冲突（DOCUMENT_CONFLICT）原样传播", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    vi.spyOn(ctx.commit, "commit").mockRejectedValue(
      new DomainError("DOCUMENT_CONFLICT", "文档已被其他窗口修改。"),
    );
    await expect(
      ctx.commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "../old/旧方案.md",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
  });

  it("源文档为兼容模式只读时拒绝改写", async () => {
    const ctx = makeContext();
    const { source, target } = await seedDocuments(ctx);
    // 包一层只读打开语义。
    const readonlyContent: ContentRepository & DocumentOpenCapable = {
      ...ctx.repos.content,
      async openDocument(pageId): Promise<DocumentOpenResult> {
        const found: DocumentContent | undefined =
          await ctx.repos.content.get(pageId);
        if (!found) {
          throw new DomainError("PAGE_NOT_FOUND", "源文档不存在或已被删除。");
        }
        return {
          content: found,
          access: "read-only",
          writePolicy: DEFAULT_WRITE_POLICY,
          compatibility: { lossy: true, unsupported: [] },
          source: {
            relativePath: ctx.paths[pageId],
            versionToken: found.version as ContentVersionToken,
          },
        };
      },
    };
    const commands = new DocumentCommandService({
      documentCommit: ctx.commit,
      documentQueries: new DocumentQueryService({
        content: readonlyContent,
        revisions: ctx.repos.revision,
      }),
    });
    await expect(
      commands.relocateBrokenLink({
        sourcePageId: source.id,
        oldHref: "../old/旧方案.md",
        newTargetPageId: target.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
