/**
 * R009 Stage 0.3（§3.4）：createMockDesktopApi mock 完整性测试。
 *
 * 双保险防漂移：
 * - 编译期：工厂默认产物标注为 E1DesktopAPI，契约加组/加方法/改签名即
 *   typecheck 失败；
 * - 运行期：本测试对比工厂产物的键集合与契约快照（下方 EXPECTED_SHAPE），
 *   任一侧演进而另一侧未同步即失败。
 *
 * EXPECTED_SHAPE 的键集合与 electron/preload/preload.test.ts 的暴露形状
 * 断言互为参照（同一契约的生产侧/测试侧两端）。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyVaultState } from "../../shared/ipc/contracts";
import { createMockDesktopApi } from "./createMockDesktopApi";

/** 契约形状快照（键均按字典序）。 */
const EXPECTED_GROUPS = [
  "asset",
  "events",
  "fileOperation",
  "links",
  "note",
  "platform",
  "search",
  "secret",
  "update",
  "vault",
  "vaultState",
  "versions",
] as const;

const EXPECTED_SHAPE: Record<string, string[]> = {
  vault: [
    "createDirectory",
    "listRecent",
    "listTrash",
    "openRecent",
    "openSelection",
    "purgeTrash",
    "rename",
    "restore",
    "scan",
    "selectDirectory",
    "trash",
  ],
  vaultState: ["get", "patch"],
  note: [
    "create",
    "move",
    "patchMetadata",
    "read",
    "renameFile",
    "reveal",
    "save",
  ],
  secret: ["get", "remove", "set", "status"],
  search: ["query", "rebuild", "relocate", "remove", "status", "upsert"],
  links: [
    "analyzeRelocation",
    "backlinks",
    "broken",
    "outgoing",
    "rebuild",
    "relocate",
    "remove",
    "status",
    "upsert",
  ],
  fileOperation: ["execute", "plan", "recover", "recoveryStatus"],
  asset: ["import", "pick", "read", "resolveUrl", "reveal"],
  events: ["subscribeUpdateStatus", "subscribeVaultChanges"],
  update: ["check", "download", "getState", "install", "openReleasePage"],
};

describe("createMockDesktopApi（R009 Stage 0.3）", () => {
  it("产物键集合与 E1DesktopAPI 契约形状一致", () => {
    const api = createMockDesktopApi();
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_GROUPS]);
    for (const [group, methods] of Object.entries(EXPECTED_SHAPE)) {
      const value = api[group as keyof typeof api];
      expect(typeof value, `${group} 应为对象`).toBe("object");
      expect(
        Object.keys(value as Record<string, unknown>).sort(),
        `${group} 组方法集合漂移`,
      ).toEqual(methods);
    }
  });

  it("默认行为：空列表/空状态/成功信封语义，全部为 vi.fn", async () => {
    const api = createMockDesktopApi();
    expect(vi.isMockFunction(api.vault.scan)).toBe(true);
    expect(vi.isMockFunction(api.events.subscribeVaultChanges)).toBe(true);
    await expect(api.vault.listRecent()).resolves.toEqual([]);
    await expect(api.vault.listTrash({ vaultId: "v1" })).resolves.toEqual({
      entries: [],
    });
    await expect(api.vaultState.get("v1")).resolves.toEqual(
      createEmptyVaultState(),
    );
    await expect(
      api.vaultState.patch({ vaultId: "v1", patch: {} }),
    ).resolves.toEqual(createEmptyVaultState());
    await expect(api.vault.selectDirectory()).resolves.toBeNull();
    await expect(api.asset.pick()).resolves.toBeNull();
    await expect(api.secret.get("ai.apiKey")).resolves.toBeNull();
    await expect(api.search.query({ query: "x" })).resolves.toEqual([]);
    await expect(api.search.status({ vaultId: "v1" })).resolves.toEqual({
      state: "missing",
    });
    // 事件订阅默认返回 no-op 取消订阅函数（同步返回，非 Promise）。
    const unsubscribe = api.events.subscribeVaultChanges(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("按组部分覆盖：覆盖生效、同组其它方法保留默认、undefined 回退默认", async () => {
    const scan = vi.fn(async () => ({
      vault: { vaultId: "v1", name: "定制库" },
      entries: [],
    }));
    const api = createMockDesktopApi({
      vault: { scan, listRecent: undefined },
    });
    await api.vault.scan("v1");
    expect(scan).toHaveBeenCalledWith("v1");
    // undefined 覆盖不生效：回退默认空列表。
    await expect(api.vault.listRecent()).resolves.toEqual([]);
    // 未覆盖的组与方法保持默认。
    await expect(
      api.note.reveal({ vaultId: "v1", relativePath: "a.md" }),
    ).resolves.toBeUndefined();
    expect(api.platform).toBe("desktop");
  });
});
