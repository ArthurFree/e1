/**
 * DesktopDocumentSourceCache（R006-C4-D FR-17/18）。
 */
import { describe, expect, it } from "vitest";
import {
  DesktopDocumentSourceCache,
  type DesktopDocumentSourceContext,
} from "./DesktopDocumentSourceCache";

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

describe("DesktopDocumentSourceCache", () => {
  it("set/get/updateVersion/remove", () => {
    const cache = new DesktopDocumentSourceCache();
    const ctx = sample();
    cache.set("01JABC", ctx);
    expect(cache.get("01JABC")).toEqual(ctx);
    cache.updateVersion("01JABC", `sha256:${"b".repeat(64)}`);
    expect(cache.get("01JABC")?.versionToken).toBe(`sha256:${"b".repeat(64)}`);
    cache.remove("01JABC");
    expect(cache.get("01JABC")).toBeNull();
  });

  it("clearVault 只清指定 Vault；updateStableNoteId 写回 metadata.id", () => {
    const cache = new DesktopDocumentSourceCache();
    cache.set("p1", sample({ vaultId: "v1", sessionPageId: "p1" }));
    cache.set(
      "p2",
      sample({ vaultId: "v2", sessionPageId: "p2", stableNoteId: null }),
    );
    cache.updateStableNoteId("p2", "01NEW");
    expect(cache.get("p2")?.stableNoteId).toBe("01NEW");
    expect(cache.get("p2")?.metadata.id).toBe("01NEW");
    cache.clearVault("v1");
    expect(cache.get("p1")).toBeNull();
    expect(cache.get("p2")).not.toBeNull();
  });

  it("approve* 只改当前会话 writeSession，不永久记忆", () => {
    const cache = new DesktopDocumentSourceCache();
    cache.set("p1", sample());
    cache.approveSourceLossy("p1");
    cache.approveOutputLossy("p1");
    cache.approveIdentityAdoption("p1");
    expect(cache.get("p1")?.writeSession).toEqual({
      sourceLossyApproved: true,
      outputLossyApproved: true,
      identityAdoptionApproved: true,
    });
    cache.remove("p1");
    cache.set("p1", sample());
    expect(cache.get("p1")?.writeSession.identityAdoptionApproved).toBe(false);
  });

  it("updateRelativePath 只改路径（R007 §3.4 外部移动），未知 pageId 为 no-op", () => {
    const cache = new DesktopDocumentSourceCache();
    cache.set("01JABC", sample());
    cache.updateRelativePath("01JABC", "归档/React.md");
    const ctx = cache.get("01JABC");
    expect(ctx?.relativePath).toBe("归档/React.md");
    // 其余字段（含 versionToken / metadata）保持不变。
    expect(ctx?.metadata.title).toBe("React");
    expect(ctx?.versionToken).toBe(`sha256:${"a".repeat(64)}`);
    cache.updateRelativePath("不存在", "x.md");
    expect(cache.get("不存在")).toBeNull();
  });
});
