/**
 * R012 Stage 2：DesktopRevisionRepository（IPC-backed RevisionRepository）
 * 测试——身份翻译（pageId → vaultId/relativePath/stableNoteId）、summary/
 * DocumentRevision 映射、add 忽略 contentJson/textSnapshot、未扫描到文档
 * 按 stub 语义降级、IPC 错误 → DomainError。
 */
import { describe, expect, it, vi } from "vitest";
import type { RevisionRepository } from "../../domain/repositories";
import { DesktopIpcError } from "./desktopApi";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopRevisionRepository } from "./DesktopRevisionRepository";
import { DesktopVaultScanCache } from "./DesktopVaultScanCache";

const ENTRY = {
  noteId: "01JABC",
  relativePath: "学习/甲.md",
  kind: "document" as const,
  title: "甲",
  parentPath: "学习",
  tags: [],
};

/** 扫描快照含一条文档（stable id 01JABC）；pageId 即 stableNoteId。 */
function setup() {
  const api = createMockDesktopApi({
    vault: {
      scan: async (vaultId) => ({
        vault: { vaultId, name: vaultId, assetsDirectory: "assets" },
        entries: [ENTRY],
      }),
    },
  });
  const scans = new DesktopVaultScanCache(api);
  const repo: RevisionRepository = new DesktopRevisionRepository(api, scans);
  return { api, scans, repo };
}

/** 预热扫描缓存（findDocument 依赖已缓存快照）。 */
async function scanned() {
  const ctx = setup();
  await ctx.scans.scan("v1");
  return ctx;
}

describe("身份翻译与映射", () => {
  it("listByPage：pageId 翻译为 vaultId/relativePath/stableNoteId，摘要映射（bytes=bodyBytes、ISO→ms）", async () => {
    const { api, repo } = await scanned();
    api.revisions.list = vi.fn(async () => ({
      summaries: [
        {
          revisionId: "r2",
          reason: "manual" as const,
          createdAt: "2026-09-07T08:00:00.000Z",
          bodyBytes: 128,
          textPreview: "第二版",
        },
        {
          revisionId: "r1",
          reason: "interval" as const,
          createdAt: "2026-09-07T07:55:00.000Z",
          bodyBytes: 64,
          textPreview: "第一版",
        },
      ],
    }));
    const list = await repo.listByPage("01JABC");
    expect(api.revisions.list).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: "01JABC",
    });
    expect(list).toEqual([
      {
        id: "r2",
        pageId: "01JABC",
        createdAt: Date.parse("2026-09-07T08:00:00.000Z"),
        reason: "manual",
        bytes: 128,
        textPreview: "第二版",
      },
      {
        id: "r1",
        pageId: "01JABC",
        createdAt: Date.parse("2026-09-07T07:55:00.000Z"),
        reason: "interval",
        bytes: 64,
        textPreview: "第一版",
      },
    ]);
  });

  it("get：映射为 DocumentRevision——contentJson 恒 null、textSnapshot 为 raw body；null → undefined", async () => {
    const { api, repo } = await scanned();
    api.revisions.get = vi.fn(async (input) =>
      input.revisionId === "r1"
        ? {
            revisionId: "r1",
            reason: "manual" as const,
            createdAt: "2026-09-07T08:00:00.000Z",
            body: "# 旧正文\n",
            bodyBytes: 12,
            lineEnding: "lf" as const,
            relativePathAtCapture: "学习/甲.md",
          }
        : null,
    );
    const revision = await repo.get("01JABC", "r1");
    expect(api.revisions.get).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: "01JABC",
      revisionId: "r1",
    });
    expect(revision).toEqual({
      id: "r1",
      pageId: "01JABC",
      contentJson: null,
      textSnapshot: "# 旧正文\n",
      createdAt: Date.parse("2026-09-07T08:00:00.000Z"),
      reason: "manual",
    });
    await expect(repo.get("01JABC", "r-none")).resolves.toBeUndefined();
  });

  it("add：忽略 contentJson/textSnapshot（Main 读盘为准），转发 reason；返回摘要", async () => {
    const { api, repo } = await scanned();
    const capture = vi.fn(async () => ({
      revisionId: "r3",
      reason: "manual" as const,
      createdAt: "2026-09-07T09:00:00.000Z",
      bodyBytes: 256,
      textPreview: "新版",
    }));
    api.revisions.capture = capture;
    const summary = await repo.add(
      "01JABC",
      { type: "doc", content: [{ type: "paragraph" }] },
      "Renderer 侧文本快照（不应被发送）",
      "manual",
    );
    // 断言 capture 入参只有定位 + reason——正文不跨 IPC（§44）。
    expect(capture).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: "01JABC",
      reason: "manual",
    });
    expect(summary).toEqual({
      id: "r3",
      pageId: "01JABC",
      createdAt: Date.parse("2026-09-07T09:00:00.000Z"),
      reason: "manual",
      bytes: 256,
      textPreview: "新版",
    });
  });

  it("add：去重命中（capture 返回 null）→ null", async () => {
    const { api, repo } = await scanned();
    api.revisions.capture = vi.fn(async () => null);
    await expect(repo.add("01JABC", {}, "", "interval")).resolves.toBeNull();
  });

  it("pruneInterval：转发 keep/maxBytes（maxBytes 缺省不携带）", async () => {
    const { api, repo } = await scanned();
    const prune = vi.fn(async () => ({ pruned: 1 }));
    api.revisions.prune = prune;
    await repo.pruneInterval("01JABC", 100, 5 * 1024 * 1024);
    expect(prune).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: "01JABC",
      keep: 100,
      maxBytes: 5 * 1024 * 1024,
    });
    await repo.pruneInterval("01JABC", 100);
    expect(prune).toHaveBeenLastCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: "01JABC",
      keep: 100,
    });
  });

  it("path-only 文档（无 stable id）：stableNoteId 传 null", async () => {
    const api = createMockDesktopApi({
      vault: {
        scan: async (vaultId) => ({
          vault: { vaultId, name: vaultId, assetsDirectory: "assets" },
          entries: [{ ...ENTRY, noteId: null }],
        }),
      },
    });
    const scans = new DesktopVaultScanCache(api);
    const repo = new DesktopRevisionRepository(api, scans);
    await scans.scan("v1");
    await repo.listByPage("path:学习/甲.md");
    expect(api.revisions.list).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/甲.md",
      stableNoteId: null,
    });
  });
});

describe("降级与错误映射", () => {
  it("未扫描到文档：list → []、get → undefined、add → null、prune no-op，均不发 IPC", async () => {
    const { api, scans, repo } = setup();
    await scans.scan("v1");
    await expect(repo.listByPage("unknown")).resolves.toEqual([]);
    await expect(repo.get("unknown", "r1")).resolves.toBeUndefined();
    await expect(repo.add("unknown", {}, "", "manual")).resolves.toBeNull();
    await expect(repo.pruneInterval("unknown", 100)).resolves.toBeUndefined();
    expect(api.revisions.list).not.toHaveBeenCalled();
    expect(api.revisions.get).not.toHaveBeenCalled();
    expect(api.revisions.capture).not.toHaveBeenCalled();
    expect(api.revisions.prune).not.toHaveBeenCalled();
  });

  it("IPC 错误 → DomainError（NOTE_NOT_FOUND/VAULT_NOT_FOUND/DOCUMENT_CONFLICT/NOT_IMPLEMENTED）", async () => {
    const { api, repo } = await scanned();
    const cases: Array<[string, string]> = [
      ["NOTE_NOT_FOUND", "PAGE_NOT_FOUND"],
      ["VAULT_NOT_FOUND", "WORKSPACE_NOT_FOUND"],
      ["DOCUMENT_CONFLICT", "DOCUMENT_CONFLICT"],
      ["NOT_IMPLEMENTED", "NOT_IMPLEMENTED"],
      ["VAULT_READ_ONLY", "VAULT_READ_ONLY"],
    ];
    for (const [ipcCode, domainCode] of cases) {
      api.revisions.list = vi.fn(async () => {
        throw new DesktopIpcError(
          ipcCode as ConstructorParameters<typeof DesktopIpcError>[0],
          "测试错误",
        );
      });
      await expect(repo.listByPage("01JABC")).rejects.toMatchObject({
        name: "DomainError",
        code: domainCode,
      });
    }
    // 未识别的 IPC 码原样抛出（不包成 DomainError）。
    api.revisions.list = vi.fn(async () => {
      throw new DesktopIpcError("INTERNAL", "boom");
    });
    await expect(repo.listByPage("01JABC")).rejects.toBeInstanceOf(
      DesktopIpcError,
    );
  });
});
