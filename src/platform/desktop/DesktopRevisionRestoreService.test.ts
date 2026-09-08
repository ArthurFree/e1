/**
 * R012 Stage 4（需求 §23/§43）：DesktopRevisionRestoreService 测试——
 * revision.restore IPC 收口：SourceCache 令牌推进、版本通道发布（旧
 * autosave 不覆盖 restore）、LinkIndex/SearchIndex 显式 reconcile
 *（失败仅降级）、IPC 错误 → DomainError。
 */
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../domain/errors";
import { DesktopIpcError } from "./desktopApi";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopDocumentSourceContext } from "./DesktopDocumentSourceCache";
import { createInMemoryDocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import { DesktopRevisionRestoreService } from "./DesktopRevisionRestoreService";

const PAGE_ID = "01JABC";
const OLD_TOKEN = `sha256:${"a".repeat(64)}`;
const NEW_TOKEN = `sha256:${"b".repeat(64)}`;

function sampleCtx(): DesktopDocumentSourceContext {
  return {
    vaultId: "v1",
    sessionPageId: PAGE_ID,
    relativePath: "学习/React.md",
    stableNoteId: "01JABC",
    metadata: { id: "01JABC", title: "React", tags: [], aliases: [] },
    frontmatterExtra: [],
    lineEnding: "lf",
    hadUtf8Bom: false,
    versionToken: OLD_TOKEN,
    compatibility: { lossy: false, unsupported: [] },
    writeSession: {
      sourceLossyApproved: false,
      outputLossyApproved: false,
      identityAdoptionApproved: false,
    },
  };
}

const TARGET = {
  id: "r1",
  pageId: PAGE_ID,
  contentJson: null,
  textSnapshot: "历史正文",
  createdAt: 1000,
  reason: "interval" as const,
};

function setup(
  overrides: {
    restore?: (input: unknown) => Promise<unknown>;
    noteRead?: (input: unknown) => Promise<unknown>;
  } = {},
) {
  const restore = vi.fn(
    overrides.restore ??
      (async () => ({ versionToken: NEW_TOKEN, updatedAt: 2000 })),
  );
  const api = createMockDesktopApi({
    revisions: { restore: restore as never },
    note: overrides.noteRead
      ? { read: overrides.noteRead as never }
      : undefined,
  });
  const sources = new DesktopDocumentSourceCache();
  sources.set(PAGE_ID, sampleCtx());
  const versionChannel = createInMemoryDocumentVersionChannel();
  const published: string[] = [];
  versionChannel.subscribe(PAGE_ID, (v) => published.push(v));
  const linkIndex = { upsert: vi.fn(async () => ({ indexed: true })) };
  const fullTextSearch = { upsert: vi.fn(async () => undefined) };
  const service = new DesktopRevisionRestoreService({
    api,
    sources,
    versionChannel,
    linkIndex: linkIndex as never,
    fullTextSearch: fullTextSearch as never,
  });
  return {
    api,
    sources,
    versionChannel,
    published,
    linkIndex,
    fullTextSearch,
    service,
    restore,
  };
}

describe("DesktopRevisionRestoreService", () => {
  it("成功：IPC 携带 SourceCache 令牌；SourceCache/版本通道推进；双索引显式 upsert", async () => {
    const { service, restore, sources, published, linkIndex, fullTextSearch } =
      setup();
    const outcome = await service.restore({
      pageId: PAGE_ID,
      target: TARGET,
      current: { contentJson: null, textSnapshot: "" },
      commit: vi.fn(),
    });
    expect(outcome).toEqual({ reloadedExternally: true });
    // 乐观锁：携带 SourceCache 当前令牌。
    expect(restore).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
      stableNoteId: "01JABC",
      revisionId: "r1",
      expectedVersionToken: OLD_TOKEN,
    });
    // SourceCache 推进（后续 autosave 拿新令牌，不假冲突）。
    expect(sources.get(PAGE_ID)?.versionToken).toBe(NEW_TOKEN);
    // 版本通道发布（打开中的协调器采纳新令牌）。
    expect(published).toEqual([NEW_TOKEN]);
    // 显式 reconcile（不依赖 watcher）。
    expect(linkIndex.upsert).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    expect(fullTextSearch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: "v1", relativePath: "学习/React.md" }),
    );
  });

  it("DOCUMENT_CONFLICT → DomainError，不推进令牌、不 reconcile", async () => {
    const { service, sources, published, linkIndex } = setup({
      restore: async () => {
        throw new DesktopIpcError("DOCUMENT_CONFLICT", "磁盘已变化");
      },
    });
    await expect(
      service.restore({
        pageId: PAGE_ID,
        target: TARGET,
        current: { contentJson: null, textSnapshot: "" },
        commit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    expect(sources.get(PAGE_ID)?.versionToken).toBe(OLD_TOKEN);
    expect(published).toEqual([]);
    expect(linkIndex.upsert).not.toHaveBeenCalled();
  });

  it("版本不存在（NOTE_NOT_FOUND）→ REVISION_NOT_FOUND", async () => {
    const { service } = setup({
      restore: async () => {
        throw new DesktopIpcError(
          "NOTE_NOT_FOUND",
          "该版本已不存在或无法读取。",
        );
      },
    });
    await expect(
      service.restore({
        pageId: PAGE_ID,
        target: TARGET,
        current: { contentJson: null, textSnapshot: "" },
        commit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  });

  it("Source Context 缺失 → DOCUMENT_SOURCE_CONTEXT_REQUIRED，不调 IPC", async () => {
    const { service, restore, sources } = setup();
    sources.remove(PAGE_ID);
    await expect(
      service.restore({
        pageId: PAGE_ID,
        target: TARGET,
        current: { contentJson: null, textSnapshot: "" },
        commit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_CONTEXT_REQUIRED" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("索引 reconcile 失败仅降级：正文恢复结果不回滚（§43）", async () => {
    const { service, sources, linkIndex, fullTextSearch } = setup();
    linkIndex.upsert.mockRejectedValue(new Error("sqlite 故障"));
    fullTextSearch.upsert.mockRejectedValue(new Error("sqlite 故障"));
    const outcome = await service.restore({
      pageId: PAGE_ID,
      target: TARGET,
      current: { contentJson: null, textSnapshot: "" },
      commit: vi.fn(),
    });
    expect(outcome).toEqual({ reloadedExternally: true });
    expect(sources.get(PAGE_ID)?.versionToken).toBe(NEW_TOKEN);
  });

  it("transient 拒写（VAULT_READ_ONLY）原样映射", async () => {
    const { service } = setup({
      restore: async () => {
        throw new DesktopIpcError(
          "VAULT_READ_ONLY",
          "仅预览知识库不能修改版本历史。",
        );
      },
    });
    const err = await service
      .restore({
        pageId: PAGE_ID,
        target: TARGET,
        current: { contentJson: null, textSnapshot: "" },
        commit: vi.fn(),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("VAULT_READ_ONLY");
  });
});

describe("DesktopRevisionRestoreService.readCurrentSource（R012 Stage 5，需求 §27）", () => {
  it("note.read 成功 → 剥离 Frontmatter 返回 raw body", async () => {
    const noteRead = vi.fn(async () => ({
      stableNoteId: "01JABC",
      relativePath: "学习/React.md",
      markdown:
        "---\nid: 01JABC\ntitle: React\n---\n正文第一行\n\n正文第二行\n",
      versionToken: OLD_TOKEN,
      source: { modifiedAt: 0, sizeBytes: 0 },
    }));
    const { service } = setup({ noteRead });
    await expect(service.readCurrentSource(PAGE_ID)).resolves.toBe(
      "正文第一行\n\n正文第二行\n",
    );
    // 按 Source Cache 的 vaultId/relativePath 寻址。
    expect(noteRead).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("Source Context 缺失 → null，不调 IPC", async () => {
    const noteRead = vi.fn(async () => {
      throw new Error("不应被调用");
    });
    const { service, sources } = setup({ noteRead });
    sources.remove(PAGE_ID);
    await expect(service.readCurrentSource(PAGE_ID)).resolves.toBeNull();
    expect(noteRead).not.toHaveBeenCalled();
  });

  it("IPC 失败 → null（diff 是只读增强，降级不抛错）", async () => {
    const { service } = setup({
      noteRead: async () => {
        throw new DesktopIpcError("NOTE_NOT_FOUND", "文档已消失");
      },
    });
    await expect(service.readCurrentSource(PAGE_ID)).resolves.toBeNull();
  });
});
