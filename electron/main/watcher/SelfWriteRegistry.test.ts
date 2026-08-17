// @vitest-environment node
/**
 * R007 阶段 3：SelfWriteRegistry 自写抑制测试——过期/消费/token 比对。
 */
import { describe, expect, it } from "vitest";
import { SelfWriteRegistry } from "./SelfWriteRegistry.js";

function makeRegistry(ttlMs = 10_000): {
  registry: SelfWriteRegistry;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const registry = new SelfWriteRegistry(ttlMs, () => now);
  return { registry, advance: (ms) => (now += ms) };
}

describe("SelfWriteRegistry", () => {
  it("无记录 → 不抑制", () => {
    const { registry } = makeRegistry();
    expect(registry.shouldSuppress("v1", "a.md", "sha256:x")).toBe(false);
  });

  it("记录有 token 且与当前 hash 相等 → 抑制并消费", () => {
    const { registry } = makeRegistry();
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:aaa",
    });
    expect(registry.shouldSuppress("v1", "a.md", "sha256:aaa")).toBe(true);
    // 已消费：第二次不再抑制。
    expect(registry.shouldSuppress("v1", "a.md", "sha256:aaa")).toBe(false);
  });

  it("token 不等 → 不抑制且保留记录（外部写叠加场景）", () => {
    const { registry } = makeRegistry();
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:aaa",
    });
    expect(registry.shouldSuppress("v1", "a.md", "sha256:外部")).toBe(false);
    // 未消费：随后到达的自写回声（内容回到自写结果）仍可被抑制。
    expect(registry.shouldSuppress("v1", "a.md", "sha256:aaa")).toBe(true);
  });

  it("记录无 token（asset 场景）→ 不论 currentToken 均抑制", () => {
    const { registry } = makeRegistry();
    registry.record({ vaultId: "v1", relativePath: "assets/x.png" });
    expect(registry.shouldSuppress("v1", "assets/x.png", null)).toBe(true);
  });

  it("有 token 的记录遇 unlink（currentToken=null）→ 不抑制", () => {
    const { registry } = makeRegistry();
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:aaa",
    });
    expect(registry.shouldSuppress("v1", "a.md", null)).toBe(false);
  });

  it("过期记录 → 不抑制并清理", () => {
    const { registry, advance } = makeRegistry(1_000);
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:aaa",
    });
    advance(1_001);
    expect(registry.shouldSuppress("v1", "a.md", "sha256:aaa")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("同 key 重复 record 覆写旧记录；不同 vaultId/path 互不影响", () => {
    const { registry } = makeRegistry();
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:旧",
    });
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: "sha256:新",
    });
    registry.record({ vaultId: "v2", relativePath: "a.md" });
    expect(registry.size).toBe(2);
    expect(registry.shouldSuppress("v1", "a.md", "sha256:旧")).toBe(false);
    expect(registry.shouldSuppress("v1", "a.md", "sha256:新")).toBe(true);
    expect(registry.shouldSuppress("v2", "a.md", null)).toBe(true);
  });

  it("versionToken 显式传 null 按无 token 处理", () => {
    const { registry } = makeRegistry();
    registry.record({
      vaultId: "v1",
      relativePath: "a.md",
      versionToken: null,
    });
    expect(registry.shouldSuppress("v1", "a.md", "sha256:任意")).toBe(true);
  });
});
