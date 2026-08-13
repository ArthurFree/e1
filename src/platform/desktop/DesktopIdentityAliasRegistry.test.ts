/**
 * DesktopIdentityAliasRegistry（R006-C4.1 FR-07/11）。
 */
import { describe, expect, it } from "vitest";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";

describe("DesktopIdentityAliasRegistry", () => {
  it("register 后可按 session / stable / vault+path 反查", () => {
    const registry = new DesktopIdentityAliasRegistry();
    const alias = {
      vaultId: "v1",
      sessionPageId: "path:React.md",
      stableNoteId: "abc-123",
      relativePath: "React.md",
    };
    registry.register(alias);
    expect(registry.getBySessionPageId("path:React.md")).toEqual(alias);
    expect(registry.getByStableNoteId("abc-123")).toEqual(alias);
    expect(registry.getByRelativePath("v1", "React.md")).toEqual(alias);
    expect(registry.getByRelativePath("v2", "React.md")).toBeNull();
  });

  it("clearVault 只清指定 Vault；clear 清空全部", () => {
    const registry = new DesktopIdentityAliasRegistry();
    registry.register({
      vaultId: "v1",
      sessionPageId: "path:a.md",
      stableNoteId: "id-a",
      relativePath: "a.md",
    });
    registry.register({
      vaultId: "v2",
      sessionPageId: "path:b.md",
      stableNoteId: "id-b",
      relativePath: "b.md",
    });
    registry.clearVault("v1");
    expect(registry.getBySessionPageId("path:a.md")).toBeNull();
    expect(registry.getByStableNoteId("id-a")).toBeNull();
    expect(registry.getBySessionPageId("path:b.md")?.stableNoteId).toBe("id-b");
    registry.clear();
    expect(registry.getBySessionPageId("path:b.md")).toBeNull();
  });
});
