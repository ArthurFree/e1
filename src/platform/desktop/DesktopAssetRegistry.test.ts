import { describe, expect, it } from "vitest";
import { DesktopAssetRegistry } from "./DesktopAssetRegistry";

describe("DesktopAssetRegistry", () => {
  it("register / get / findByPath / listByDocument / clearVault", () => {
    const registry = new DesktopAssetRegistry();
    registry.register({
      id: "a1",
      vaultId: "v1",
      relativePath: "assets/a.png",
      name: "a.png",
      mimeType: "image/png",
      size: 3,
      pageId: "p1",
    });
    expect(registry.get("a1")?.name).toBe("a.png");
    expect(registry.findByPath("v1", "assets/a.png")?.id).toBe("a1");
    expect(registry.listByDocument("p1")).toHaveLength(1);
    registry.removeSessionReference("a1");
    expect(registry.get("a1")).toBeUndefined();
  });

  it("clearVault 只清指定库", () => {
    const registry = new DesktopAssetRegistry();
    registry.register({
      id: "a1",
      vaultId: "v1",
      relativePath: "assets/a.png",
      name: "a.png",
      mimeType: "image/png",
      size: 1,
      pageId: "p1",
    });
    registry.register({
      id: "b1",
      vaultId: "v2",
      relativePath: "assets/a.png",
      name: "a.png",
      mimeType: "image/png",
      size: 1,
      pageId: "p2",
    });
    registry.clearVault("v1");
    expect(registry.get("a1")).toBeUndefined();
    expect(registry.get("b1")).toBeDefined();
  });
});
