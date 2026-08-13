/**
 * R006-C4.1-A：统一写入服务——save / replace-content 共用 Gate。
 */
import { describe, expect, it, vi } from "vitest";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopDocumentSourceContext } from "./DesktopDocumentSourceCache";
import { DesktopMarkdownWriteService } from "./DesktopMarkdownWriteService";
import { DesktopVaultScanCache } from "./repositories";

const DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function sample(
  overrides: Partial<DesktopDocumentSourceContext> = {},
): DesktopDocumentSourceContext {
  return {
    vaultId: "v1",
    sessionPageId: "01JABC",
    relativePath: "学习/React.md",
    stableNoteId: "01JABC",
    metadata: { id: "01JABC", title: "React", tags: [], aliases: [] },
    frontmatterExtra: [],
    lineEnding: "lf",
    hadUtf8Bom: false,
    versionToken: `sha256:${"a".repeat(64)}`,
    compatibility: { lossy: false, unsupported: [] },
    writeSession: {
      sourceLossyApproved: false,
      outputLossyApproved: false,
      identityAdoptionApproved: false,
    },
    ...overrides,
  };
}

function mockApi(save = vi.fn(async () => ({
  versionToken: `sha256:${"b".repeat(64)}`,
  source: { modifiedAt: 1, sizeBytes: 10 },
}))): E1DesktopAPI {
  return {
    platform: "desktop",
    versions: {},
    vault: {
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "n" },
        entries: [],
      })),
      listRecent: vi.fn(async () => []),
      selectDirectory: vi.fn(),
      openRecent: vi.fn(),
      openSelection: vi.fn(),
    },
    note: { read: vi.fn(), create: vi.fn(), save },
    asset: { pick: vi.fn(), import: vi.fn(), read: vi.fn(), resolveUrl: vi.fn() },
  } as unknown as E1DesktopAPI;
}

function makeWriter(save = vi.fn(async () => ({
  versionToken: `sha256:${"b".repeat(64)}`,
  source: { modifiedAt: 1, sizeBytes: 10 },
}))) {
  const api = mockApi(save);
  const sources = new DesktopDocumentSourceCache();
  const scans = new DesktopVaultScanCache(api);
  const writer = new DesktopMarkdownWriteService(api, sources, scans);
  return { api, sources, scans, writer, save };
}

describe("DesktopMarkdownWriteService", () => {
  it("无 Source Context → DOCUMENT_SOURCE_CONTEXT_REQUIRED，不调用 note.save", async () => {
    const { writer, save } = makeWriter();
    await expect(
      writer.save({
        pageId: "missing",
        contentJson: DOC,
        expectedVersionToken: "sha256:x",
        mode: "replace-content",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_CONTEXT_REQUIRED" });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["autosave", "replace-content"] as const)(
    "%s：无稳定 id 且未 Adoption → 不写盘",
    async (mode) => {
      const { writer, sources, save } = makeWriter();
      sources.set(
        "path:随笔.md",
        sample({
          sessionPageId: "path:随笔.md",
          relativePath: "随笔.md",
          stableNoteId: null,
          metadata: { title: "随笔", tags: [], aliases: [] },
        }),
      );
      await expect(
        writer.save({
          pageId: "path:随笔.md",
          contentJson: DOC,
          expectedVersionToken: `sha256:${"a".repeat(64)}`,
          mode,
        }),
      ).rejects.toMatchObject({
        code: "MARKDOWN_LOSSY_OUTPUT",
        details: { phase: "identity-adoption" },
      });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each(["autosave", "replace-content"] as const)(
    "%s：source lossy 未授权 → 不写盘",
    async (mode) => {
      const { writer, sources, save } = makeWriter();
      sources.set(
        "01JABC",
        sample({
          compatibility: {
            lossy: true,
            unsupported: [{ kind: "wiki-link", message: "Wiki 链接" }],
          },
        }),
      );
      await expect(
        writer.save({
          pageId: "01JABC",
          contentJson: DOC,
          expectedVersionToken: `sha256:${"a".repeat(64)}`,
          mode,
        }),
      ).rejects.toMatchObject({
        code: "MARKDOWN_LOSSY_OUTPUT",
        details: { phase: "source" },
      });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("autosave 与 replace-content 都走 note.save，路径与 token 相同", async () => {
    const { writer, sources, save } = makeWriter();
    sources.set("01JABC", sample());
    const token = `sha256:${"a".repeat(64)}`;
    await writer.save({
      pageId: "01JABC",
      contentJson: DOC,
      expectedVersionToken: token,
      mode: "autosave",
    });
    await writer.save({
      pageId: "01JABC",
      contentJson: DOC,
      expectedVersionToken: token,
      mode: "replace-content",
    });
    expect(save).toHaveBeenCalledTimes(2);
    const payload = {
      vaultId: "v1",
      relativePath: "学习/React.md",
      expectedVersionToken: token,
      markdown: expect.stringMatching(/id: 01JABC[\s\S]*hi/),
    };
    expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining(payload));
    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining(payload));
  });
});
