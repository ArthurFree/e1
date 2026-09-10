// @vitest-environment node
/**
 * R014 Stage 3–4：跨库 Copy / Move 单元测试。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { initializeVault } from "../filesystem/VaultFileSystem.js";
import { DesktopRevisionStore } from "../revisions/DesktopRevisionStore.js";
import { VaultRegistry } from "../vaultRegistry.js";
import {
  executeCrossVaultTransfer,
  planCrossVaultTransfer,
} from "./VaultTransferEngine.js";
import { VAULT_TRANSFER_BLOCKER_CODES as CODES } from "../../../shared/vaultTransfer/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function note(id: string, title: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\n---\n\n${body}\n`;
}

async function twoVaults() {
  const src = await tmp("e1-cv-src-");
  const dst = await tmp("e1-cv-dst-");
  const user = await tmp("e1-cv-ud-");
  const srcMeta = await initializeVault(src, "源库");
  const dstMeta = await initializeVault(dst, "目标库");
  const registry = new VaultRegistry(join(user, "recent-vaults.json"));
  await registry.touch({
    vaultId: srcMeta.vaultId,
    absolutePath: src,
    displayName: "源库",
  });
  await registry.touch({
    vaultId: dstMeta.vaultId,
    absolutePath: dst,
    displayName: "目标库",
  });
  return { src, dst, srcMeta, dstMeta, roots: { registry } };
}

describe("Cross-Vault Copy", () => {
  it("复制文档生成新 stable id，源保留", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "a.md"), note("id-src-a", "甲", "正文甲"));
    const plan = await planCrossVaultTransfer({
      kind: "copy-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "a.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.notes[0]?.sourceStableId).toBe("id-src-a");
    expect(plan.notes[0]?.destinationStableId).not.toBe("id-src-a");
    expect(plan.revisions).toEqual([]);
    await executeCrossVaultTransfer({ plan, roots: ctx.roots });
    const destMd = await readFile(join(ctx.dst, "a.md"), "utf8");
    expect(splitFrontmatter(destMd).metadata.id).toBe(
      plan.notes[0]?.destinationStableId,
    );
    expect(await readFile(join(ctx.src, "a.md"), "utf8")).toContain("id-src-a");
  });

  it("复制分组保留内部相对链接并放入目标分组目录", async () => {
    const ctx = await twoVaults();
    await mkdir(join(ctx.src, "组"));
    await writeFile(
      join(ctx.src, "组", "a.md"),
      note("id-a", "A", "见 [B](b.md)。"),
    );
    await writeFile(join(ctx.src, "组", "b.md"), note("id-b", "B", "B 正文"));
    const plan = await planCrossVaultTransfer({
      kind: "copy-group",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "组",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.notes).toHaveLength(2);
    expect(plan.notes.every((n) => n.destinationPath.startsWith("组/"))).toBe(
      true,
    );
    await executeCrossVaultTransfer({ plan, roots: ctx.roots });
    const destA = await readFile(join(ctx.dst, "组", "a.md"), "utf8");
    expect(destA).toContain("(b.md)");
    expect(splitFrontmatter(destA).metadata.id).not.toBe("id-a");
  });
});

describe("Cross-Vault Move", () => {
  it("移动保持 stable id，源进回收站", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "solo.md"), note("id-solo", "独", "独正文"));
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "solo.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.notes[0]?.destinationStableId).toBe("id-solo");
    await executeCrossVaultTransfer({ plan, roots: ctx.roots });
    const destMd = await readFile(join(ctx.dst, "solo.md"), "utf8");
    expect(splitFrontmatter(destMd).metadata.id).toBe("id-solo");
    await expect(readFile(join(ctx.src, "solo.md"), "utf8")).rejects.toThrow();
  });

  it("移动迁移 revision series", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "h.md"), note("idHist01", "史", "第一版"));
    const store = new DesktopRevisionStore(ctx.src);
    await store.capture({
      seriesId: "sn_idHist01",
      relativePath: "h.md",
      reason: "interval",
      sourceVersionToken: "sha256:test",
    });
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "h.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.revisions.length).toBeGreaterThan(0);
    await executeCrossVaultTransfer({ plan, roots: ctx.roots });
    const destStore = new DesktopRevisionStore(ctx.dst);
    const listed = await destStore.list("sn_idHist01");
    expect(listed.revisions.length).toBeGreaterThan(0);
  });

  it("入边界链接阻断 Move", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "keep.md"), note("id-k", "留", "见 [走](go.md)。"));
    await writeFile(join(ctx.src, "go.md"), note("id-g", "走", "走。"));
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "go.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers.some((b) => b.code === CODES.boundaryInbound)).toBe(
      true,
    );
  });

  it("出边界链接阻断 Move", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "stay.md"), note("id-s", "留", "留。"));
    await writeFile(
      join(ctx.src, "leave.md"),
      note("id-l", "走", "见 [留](stay.md)。"),
    );
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "leave.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers.some((b) => b.code === CODES.boundaryOutbound)).toBe(
      true,
    );
  });

  it("目标碰撞阻断 Move", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "same.md"), note("id-src", "源", "源"));
    await writeFile(join(ctx.dst, "same.md"), note("id-dst", "目标", "目标"));
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "same.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers.some((b) => b.code === CODES.collision)).toBe(true);
  });

  it("预检后源变化 → STALE_PLAN", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "x.md"), note("id-x", "X", "旧"));
    const plan = await planCrossVaultTransfer({
      kind: "copy-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "x.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    await writeFile(join(ctx.src, "x.md"), note("id-x", "X", "新内容更长一些"));
    await expect(
      executeCrossVaultTransfer({ plan, roots: ctx.roots }),
    ).rejects.toMatchObject({ code: "VAULT_TRANSFER_STALE_PLAN" });
  });

  it("Copy 目标重名确定性改名，不覆盖", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "same.md"), note("id-src", "源", "源正文"));
    await writeFile(join(ctx.dst, "same.md"), note("id-dst", "目标", "目标正文"));
    const plan = await planCrossVaultTransfer({
      kind: "copy-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "same.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.notes[0]?.destinationPath).not.toBe("same.md");
    await executeCrossVaultTransfer({ plan, roots: ctx.roots });
    expect(await readFile(join(ctx.dst, "same.md"), "utf8")).toContain("id-dst");
    const copied = await readFile(
      join(ctx.dst, plan.notes[0]!.destinationPath),
      "utf8",
    );
    expect(splitFrontmatter(copied).metadata.id).toBe(
      plan.notes[0]?.destinationStableId,
    );
  });

  it("目标已有相同 Stable ID 阻断 Move", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "a.md"), note("id-shared", "源", "源"));
    await writeFile(join(ctx.dst, "other.md"), note("id-shared", "目标", "目标"));
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "a.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers.some((b) => b.code === CODES.identityCollision)).toBe(
      true,
    );
    expect(plan.blockers[0]?.message).toContain("id-shared");
    expect(plan.blockers[0]?.message).toContain("a.md");
    expect(plan.blockers[0]?.message).toContain("other.md");
  });

  it("目标已有相同 revision series 阻断 Move", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "h.md"), note("idHist02", "史", "第一版"));
    await writeFile(join(ctx.dst, "keep.md"), note("id-keep", "留", "留"));
    const srcStore = new DesktopRevisionStore(ctx.src);
    await srcStore.capture({
      seriesId: "sn_idHist02",
      relativePath: "h.md",
      reason: "interval",
      sourceVersionToken: "sha256:test",
    });
    const destStore = new DesktopRevisionStore(ctx.dst);
    await destStore.capture({
      seriesId: "sn_idHist02",
      relativePath: "keep.md",
      reason: "interval",
      sourceVersionToken: "sha256:dest",
    });
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "h.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers.some((b) => b.code === CODES.revisionCollision)).toBe(
      true,
    );
  });

  it("预检后目标出现附件 → STALE，目标字节不变", async () => {
    const ctx = await twoVaults();
    await mkdir(join(ctx.src, "assets"), { recursive: true });
    await writeFile(join(ctx.src, "assets", "pic.bin"), "source-bytes");
    await writeFile(
      join(ctx.src, "a.md"),
      note("id-a", "A", "![图](assets/pic.bin)"),
    );
    const plan = await planCrossVaultTransfer({
      kind: "copy-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "a.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.assets.length).toBeGreaterThan(0);
    await mkdir(join(ctx.dst, "assets"), { recursive: true });
    const destAsset = join(ctx.dst, plan.assets[0]!.destinationPath);
    await writeFile(destAsset, "planted-after-preflight");
    await expect(
      executeCrossVaultTransfer({ plan, roots: ctx.roots }),
    ).rejects.toMatchObject({ code: "VAULT_TRANSFER_STALE_PLAN" });
    expect(await readFile(destAsset, "utf8")).toBe("planted-after-preflight");
  });

  it("预检后目标出现相同 Stable ID → STALE", async () => {
    const ctx = await twoVaults();
    await writeFile(join(ctx.src, "a.md"), note("id-race", "源", "源"));
    const plan = await planCrossVaultTransfer({
      kind: "move-document",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "a.md",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(plan.blockers).toEqual([]);
    await writeFile(join(ctx.dst, "sneak.md"), note("id-race", "偷", "偷"));
    await expect(
      executeCrossVaultTransfer({ plan, roots: ctx.roots }),
    ).rejects.toMatchObject({ code: "VAULT_TRANSFER_STALE_PLAN" });
  });

  it("100 篇文档预检 < 1s", async () => {
    const ctx = await twoVaults();
    await mkdir(join(ctx.src, "批"));
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(
          join(ctx.src, "批", `n${i}.md`),
          note(`id-${i}`, `N${i}`, `正文 ${i}`),
        ),
      ),
    );
    const started = performance.now();
    const plan = await planCrossVaultTransfer({
      kind: "copy-group",
      sourceVaultId: ctx.srcMeta.vaultId,
      destinationVaultId: ctx.dstMeta.vaultId,
      sourceRelativePath: "批",
      destinationRelativePath: "",
      roots: ctx.roots,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(plan.notes).toHaveLength(100);
    expect(plan.blockers).toEqual([]);
  });
});
