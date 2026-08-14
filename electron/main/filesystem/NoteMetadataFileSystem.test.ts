/**
 * R007 阶段 1（DSK-03）：NoteMetadataFileSystem 测试——
 * title/tags 局部改写、正文与未知 Frontmatter 键逐字节保留、BOM/CRLF
 * 跟随、乐观锁冲突、稳定 id 返回、无 Frontmatter 文件新建块。
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import { patchNoteMetadataFile } from "./NoteMetadataFileSystem.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e1-note-meta-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写入笔记并返回其磁盘版本令牌（与实现同口径：原始字节 SHA-256）。 */
async function seedNote(
  markdown: string | Buffer,
  name = "笔记.md",
): Promise<{ relativePath: string; versionToken: string }> {
  const bytes =
    typeof markdown === "string" ? Buffer.from(markdown, "utf8") : markdown;
  await writeFile(join(root, name), bytes);
  return {
    relativePath: name,
    versionToken: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function readNote(name = "笔记.md"): Promise<string> {
  return readFile(join(root, name), "utf8");
}

const BASE_MD = [
  "---",
  "id: 01JABC",
  "title: 旧标题",
  "tags: [前端]",
  "created: 2026-08-01T00:00:00.000Z",
  "custom-key: 自定义值",
  "---",
  "",
  "正文第一行。",
  "",
  "正文第二行。",
  "",
].join("\n");

describe("patchNoteMetadataFile", () => {
  it("改标题：正文、id/tags/created 与未知键保留，返回新令牌与稳定 id", async () => {
    const seed = await seedNote(BASE_MD);
    const result = await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: seed.relativePath,
      expectedVersionToken: seed.versionToken,
      patch: { title: "新标题" },
    });

    expect(result.stableNoteId).toBe("01JABC");
    const written = await readNote();
    // 正文逐字节保留。
    expect(written).toContain("正文第一行。\n\n正文第二行。");
    // 已知键只改 title；其余保留。
    expect(written).toContain("id: 01JABC");
    expect(written).toContain("title: 新标题");
    expect(written).toContain("tags: [前端]");
    expect(written).toContain("created: 2026-08-01T00:00:00.000Z");
    expect(written).not.toContain("旧标题");
    // 未知键原样保留。
    expect(written).toContain("custom-key: 自定义值");
    // updated 键随写入刷新。
    expect(written).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
    // 返回令牌与磁盘新内容一致。
    const disk = await readFile(join(root, "笔记.md"));
    const expected = `sha256:${createHash("sha256").update(disk).digest("hex")}`;
    expect(result.versionToken).toBe(expected);
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("改标签：覆盖写入；空数组删除 tags 键", async () => {
    const seed = await seedNote(BASE_MD);
    const r1 = await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: seed.relativePath,
      expectedVersionToken: seed.versionToken,
      patch: { tags: ["前端", "后端"] },
    });
    expect(await readNote()).toContain('tags: [前端, 后端]');

    await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: seed.relativePath,
      expectedVersionToken: r1.versionToken,
      patch: { tags: [] },
    });
    const written = await readNote();
    expect(written).not.toContain("tags:");
    // 只清标签，标题不动。
    expect(written).toContain("title: 旧标题");
  });

  it("无 Frontmatter 的文件：patch title 新建 Frontmatter 块，正文保留", async () => {
    const seed = await seedNote("纯正文，没有 Frontmatter。\n");
    const result = await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: seed.relativePath,
      expectedVersionToken: seed.versionToken,
      patch: { title: "补标题" },
    });
    expect(result.stableNoteId).toBeNull();
    const written = await readNote();
    expect(written.startsWith("---\ntitle: 补标题\n")).toBe(true);
    expect(written).toContain("纯正文，没有 Frontmatter。");
  });

  it("CRLF 原文写回 CRLF；BOM 原文写回 BOM", async () => {
    const crlf = await seedNote(BASE_MD.replace(/\n/g, "\r\n"), "crlf.md");
    await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: crlf.relativePath,
      expectedVersionToken: crlf.versionToken,
      patch: { title: "CRLF 标题" },
    });
    const crlfBytes = await readFile(join(root, "crlf.md"));
    expect(crlfBytes.includes("\r\n")).toBe(true);
    expect(crlfBytes.includes("CRLF 标题")).toBe(true);
    // 不应混入孤立 LF 行尾（全部归一为 CRLF）。
    expect(crlfBytes.toString("utf8").replace(/\r\n/g, "")).not.toContain("\n");

    const bomMd = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(BASE_MD, "utf8"),
    ]);
    const bom = await seedNote(bomMd, "bom.md");
    await patchNoteMetadataFile({
      vaultRoot: root,
      relativePath: bom.relativePath,
      expectedVersionToken: bom.versionToken,
      patch: { title: "BOM 标题" },
    });
    const bomBytes = await readFile(join(root, "bom.md"));
    expect(bomBytes[0]).toBe(0xef);
    expect(bomBytes[1]).toBe(0xbb);
    expect(bomBytes[2]).toBe(0xbf);
    expect(bomBytes.toString("utf8")).toContain("BOM 标题");
  });

  it("版本令牌不一致 → DOCUMENT_CONFLICT，文件保持不变", async () => {
    const seed = await seedNote(BASE_MD);
    await expect(
      patchNoteMetadataFile({
        vaultRoot: root,
        relativePath: seed.relativePath,
        expectedVersionToken: "sha256:过期令牌",
        patch: { title: "不应写入" },
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    expect(await readNote()).toBe(BASE_MD);
  });

  it("路径逃逸与目标缺失按读取语义报错", async () => {
    const seed = await seedNote(BASE_MD);
    await expect(
      patchNoteMetadataFile({
        vaultRoot: root,
        relativePath: "../外部.md",
        expectedVersionToken: seed.versionToken,
        patch: { title: "x" },
      }),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof IpcFailure &&
        (err.code === "PATH_ESCAPE" || err.code === "INVALID_INPUT"),
    );
    await expect(
      patchNoteMetadataFile({
        vaultRoot: root,
        relativePath: "不存在.md",
        expectedVersionToken: seed.versionToken,
        patch: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });
});
