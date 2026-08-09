// @vitest-environment node
/**
 * R006 阶段 2：VaultRegistry 测试（真实 tmp 文件系统）。
 * 覆盖：touch 去重/置顶/上限 10、lastOpenedAt 倒序、list 的 accessible
 * 派生（目录被移走不删记录）、findByVaultId、损坏 JSON 备份后重置、
 * 畸形条目丢弃、缺失文件视为空表、写入往返。
 */
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VaultRegistry } from "./vaultRegistry.js";

async function makeRegistry(now?: () => Date): Promise<{
  registry: VaultRegistry;
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "e1-registry-"));
  const file = join(dir, "recent-vaults.json");
  return { registry: new VaultRegistry(file, now), dir, file };
}

describe("VaultRegistry.touch / list", () => {
  it("登记后可读回；lastOpenedAt 由注入时钟确定", async () => {
    const fixed = new Date("2026-08-09T16:00:00+08:00");
    const { registry } = await makeRegistry(() => fixed);
    await registry.touch({
      vaultId: "v1",
      absolutePath: "/x/笔记",
      displayName: "笔记",
    });
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      vaultId: "v1",
      absolutePath: "/x/笔记",
      displayName: "笔记",
      lastOpenedAt: fixed.toISOString(),
      accessible: false, // /x/笔记 不存在
    });
  });

  it("同 absolutePath 去重置顶；不同条目按打开时间倒序", async () => {
    let tick = 0;
    const { registry } = await makeRegistry(
      () => new Date(1_700_000_000_000 + ++tick * 1000),
    );
    await registry.touch({
      vaultId: "v1",
      absolutePath: "/a",
      displayName: "a",
    });
    await registry.touch({
      vaultId: "v2",
      absolutePath: "/b",
      displayName: "b",
    });
    // 再次打开 /a → 置顶且更新 vaultId/时间。
    await registry.touch({
      vaultId: "v1b",
      absolutePath: "/a",
      displayName: "a",
    });
    const list = await registry.list();
    expect(list.map((r) => r.absolutePath)).toEqual(["/a", "/b"]);
    expect(list[0].vaultId).toBe("v1b");
    expect(
      new Date(list[0].lastOpenedAt).getTime() >
        new Date(list[1].lastOpenedAt).getTime(),
    ).toBe(true);
  });

  it("上限 10 条：最久未打开的被淘汰", async () => {
    let tick = 0;
    const { registry } = await makeRegistry(
      () => new Date(1_700_000_000_000 + ++tick * 1000),
    );
    for (let i = 0; i < 12; i++) {
      await registry.touch({
        vaultId: `v${i}`,
        absolutePath: `/dir/${i}`,
        displayName: `${i}`,
      });
    }
    const list = await registry.list();
    expect(list).toHaveLength(10);
    expect(list[0].vaultId).toBe("v11");
    expect(list[9].vaultId).toBe("v2");
  });

  it("accessible：存在目录 true；目录被移走 false 且记录保留（阶段 6 重新定位）", async () => {
    const base = await mkdtemp(join(tmpdir(), "e1-registry-vault-"));
    const vaultDir = join(base, "库");
    const movedDir = join(base, "库-已移动");
    const { registry } = await makeRegistry();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(vaultDir);
    await registry.touch({
      vaultId: "v1",
      absolutePath: vaultDir,
      displayName: "库",
    });
    expect((await registry.list())[0].accessible).toBe(true);
    await rename(vaultDir, movedDir);
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].accessible).toBe(false);
  });

  it("findByVaultId：命中返回记录，未登记返回 null", async () => {
    const { registry } = await makeRegistry();
    await registry.touch({
      vaultId: "v1",
      absolutePath: "/a",
      displayName: "a",
    });
    expect(await registry.findByVaultId("v1")).toMatchObject({
      absolutePath: "/a",
    });
    expect(await registry.findByVaultId("不存在")).toBeNull();
  });
});

describe("VaultRegistry 容错", () => {
  it("文件缺失 → 空表，不抛错", async () => {
    const { registry } = await makeRegistry();
    expect(await registry.list()).toEqual([]);
  });

  it("损坏 JSON → 备份原文件（.corrupt-*）后重置为空表", async () => {
    const { registry, file } = await makeRegistry();
    await writeFile(file, "{ 坏 JSON");
    expect(await registry.list()).toEqual([]);
    const { readdir } = await import("node:fs/promises");
    const backups = (await readdir(join(file, ".."))).filter((f) =>
      f.includes(".corrupt-"),
    );
    expect(backups).toHaveLength(1);
    // 备份内容即原始损坏内容。
    const backup = await readFile(join(file, "..", backups[0]), "utf8");
    expect(backup).toBe("{ 坏 JSON");
  });

  it("顶层非数组 → 同样走备份重置；畸形条目单独丢弃", async () => {
    const { registry, file } = await makeRegistry();
    await writeFile(file, JSON.stringify({ not: "array" }));
    expect(await registry.list()).toEqual([]);

    await writeFile(
      file,
      JSON.stringify([
        {
          vaultId: "v1",
          absolutePath: "/a",
          displayName: "a",
          lastOpenedAt: "2026-01-01",
        },
        { vaultId: 42 }, // 畸形
        "junk",
      ]),
    );
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].vaultId).toBe("v1");
  });

  it("touch 后换实例读回一致（落盘往返）", async () => {
    const { registry, file } = await makeRegistry();
    await registry.touch({
      vaultId: "v1",
      absolutePath: "/a",
      displayName: "a",
    });
    const reloaded = new VaultRegistry(file);
    expect(await reloaded.findByVaultId("v1")).not.toBeNull();
    await rm(file);
    expect(await reloaded.list()).toEqual([]);
  });
});
