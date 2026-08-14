// @vitest-environment node
/**
 * R007 阶段 2：DesktopVaultStateStore 测试（真实 tmp 文件系统）。
 * 覆盖：缺失文件视为空表、patch 局部合并语义（缺省键保留/显式 null 清空/
 * 空补丁不建条目）、写入往返（重启保持）、损坏 JSON 备份后自愈、
 * 畸形页面条目逐条丢弃、vaultId 文件名片段校验（路径逃逸拒绝）。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyVaultState } from "../../../shared/ipc/contracts.js";
import { DesktopVaultStateStore } from "./DesktopVaultStateStore.js";

async function makeStore(
  now?: () => number,
): Promise<{ store: DesktopVaultStateStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "e1-vault-state-"));
  return { store: new DesktopVaultStateStore(dir, now), dir };
}

describe("DesktopVaultStateStore.get", () => {
  it("缺失文件返回空表", async () => {
    const { store } = await makeStore();
    expect(await store.get("v1")).toEqual(createEmptyVaultState());
  });

  it("损坏 JSON 备份为 .corrupt-<ts> 后自愈为空表，不抛错", async () => {
    const { store, dir } = await makeStore(() => 1722580000000);
    await writeFile(join(dir, "v1.json"), "{not-json", "utf8");
    expect(await store.get("v1")).toEqual(createEmptyVaultState());
    const files = await readdir(dir);
    expect(files).toContain("v1.json.corrupt-1722580000000");
  });

  it("顶层形状非法（version 不是 1）同样自愈", async () => {
    const { store, dir } = await makeStore();
    await writeFile(join(dir, "v1.json"), '{"version":2}', "utf8");
    expect(await store.get("v1")).toEqual(createEmptyVaultState());
  });

  it("畸形页面条目逐条丢弃，合法条目保留", async () => {
    const { store, dir } = await makeStore();
    await writeFile(
      join(dir, "v1.json"),
      JSON.stringify({
        version: 1,
        pages: {
          good: { favoriteAt: 1, lastOpenedAt: null },
          bad: { favoriteAt: "oops", lastOpenedAt: null },
          worse: 42,
        },
        workspace: { favoriteAt: 7 },
      }),
      "utf8",
    );
    const state = await store.get("v1");
    expect(state.pages).toEqual({
      good: { favoriteAt: 1, lastOpenedAt: null },
    });
    expect(state.workspace.favoriteAt).toBe(7);
  });

  it("vaultId 含路径分隔符/逃逸段 → INVALID_INPUT", async () => {
    const { store } = await makeStore();
    await expect(store.get("../etc")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(store.get("a/b")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("DesktopVaultStateStore.patch", () => {
  it("局部合并：缺省键保留原值，显式 null 清空", async () => {
    const { store } = await makeStore();
    await store.patch("v1", {
      pages: { p1: { favoriteAt: 100, lastOpenedAt: 200 } },
    });
    const afterFavorite = await store.patch("v1", {
      pages: { p1: { favoriteAt: null } },
    });
    expect(afterFavorite.pages.p1).toEqual({
      favoriteAt: null,
      lastOpenedAt: 200,
    });
    const afterWorkspace = await store.patch("v1", {
      workspace: { favoriteAt: 300 },
    });
    expect(afterWorkspace.workspace.favoriteAt).toBe(300);
  });

  it("字段全缺省的空页面补丁不新建条目", async () => {
    const { store } = await makeStore();
    const state = await store.patch("v1", { pages: { p1: {} } });
    expect(state.pages).toEqual({});
  });

  it("写入往返：新实例（模拟重启）读到持久化结果", async () => {
    const { store, dir } = await makeStore();
    await store.patch("v1", {
      pages: { "01JABC": { favoriteAt: 111, lastOpenedAt: 222 } },
      workspace: { favoriteAt: 333 },
    });
    const reopened = new DesktopVaultStateStore(dir);
    expect(await reopened.get("v1")).toEqual({
      version: 1,
      pages: { "01JABC": { favoriteAt: 111, lastOpenedAt: 222 } },
      workspace: { favoriteAt: 333 },
    });
  });

  it("落盘为格式化 JSON（可读 diff）", async () => {
    const { store, dir } = await makeStore();
    await store.patch("v1", { workspace: { favoriteAt: 1 } });
    const raw = await readFile(join(dir, "v1.json"), "utf8");
    expect(raw).toContain('"version": 1');
    expect(raw.endsWith("\n")).toBe(true);
  });
});
