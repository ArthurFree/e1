// @vitest-environment node
/**
 * R008 Stage 4（§13.2/§13.3）：DesktopSearchDatabase 单测——
 * 损坏自愈（备份 + 重建）、格式版本不兼容重建、按路径删除/移动、
 * 版本令牌读取、管理器路径护栏与跨库合并。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DesktopSearchDatabase,
  DesktopSearchIndexManager,
  buildFtsMatchQuery,
  ftsTokenStream,
  searchIndexFilePath,
  type SearchDocumentRow,
} from "./DesktopSearchDatabase.js";

const VAULT = "v-unit";

function row(
  partial: Partial<SearchDocumentRow> & { pageId: string },
): SearchDocumentRow {
  return {
    vaultId: VAULT,
    stableNoteId: null,
    relativePath: `${partial.pageId}.md`,
    title: partial.pageId,
    tags: [],
    bodyText: "",
    createdAt: null,
    updatedAt: null,
    versionToken: `sha256:${partial.pageId}`,
    ...partial,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-search-db-"));
  file = join(dir, "v-unit.sqlite");
});

describe("DesktopSearchDatabase", () => {
  it("upsert/search 往返 + 状态机 ready；versionTokenOf 读取", async () => {
    const db = new DesktopSearchDatabase(file);
    expect(db.getStatus(VAULT).state).toBe("missing");
    await db.upsert(row({ pageId: "n1", title: "组件化", bodyText: "正文一" }));
    expect(db.getStatus(VAULT)).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    expect((await db.search({ vaultId: VAULT, query: "组件化" })).length).toBe(
      1,
    );
    expect(await db.versionTokenOf("n1")).toBe("sha256:n1");
    expect(await db.versionTokenOf("missing")).toBeNull();
    db.close();
  });

  it("损坏库文件：备份 .corrupt-* 后重建空库（status=missing，可再索引）", async () => {
    await writeFile(file, "这不是 sqlite 数据库", "utf8");
    const db = new DesktopSearchDatabase(file, () => 42);
    await db.upsert(row({ pageId: "n1", bodyText: "重建后可用" }));
    expect(await readdir(dir)).toContain("v-unit.sqlite.corrupt-42");
    expect(await readFile(join(dir, "v-unit.sqlite.corrupt-42"), "utf8")).toBe(
      "这不是 sqlite 数据库",
    );
    expect(
      (await db.search({ vaultId: VAULT, query: "重建后可用" })).length,
    ).toBe(1);
    db.close();
  });

  it("格式版本不兼容：整库重建（旧索引清空）", async () => {
    const db = new DesktopSearchDatabase(file, () => 43);
    await db.upsert(row({ pageId: "n1", bodyText: "旧版索引" }));
    db.close();
    // 篡改版本标记模拟不兼容。
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw
      .prepare("UPDATE index_meta SET value = ? WHERE key = ?")
      .run("999", "index_format_version");
    raw.close();
    const reopened = new DesktopSearchDatabase(file, () => 44);
    expect(
      await reopened.search({ vaultId: VAULT, query: "旧版索引" }),
    ).toEqual([]);
    expect(reopened.getStatus(VAULT).state).toBe("missing");
    expect(await readdir(dir)).toContain("v-unit.sqlite.corrupt-44");
    reopened.close();
  });

  it("removeByPath / relocateByPath：按路径维护（文件已消失/移动场景）", async () => {
    const db = new DesktopSearchDatabase(file);
    await db.upsert(
      row({
        pageId: "01STABLE",
        stableNoteId: "01STABLE",
        relativePath: "a/x.md",
        bodyText: "路径维护",
      }),
    );
    await db.relocateByPath(VAULT, "a/x.md", "b/y.md");
    expect(
      (await db.search({ vaultId: VAULT, query: "路径维护" }))[0],
    ).toMatchObject({ pageId: "01STABLE", relativePath: "b/y.md" });
    await db.removeByPath(VAULT, "b/y.md");
    expect(await db.search({ vaultId: VAULT, query: "路径维护" })).toEqual([]);
    // 幂等：重复删除不抛错。
    await db.removeByPath(VAULT, "b/y.md");
    db.close();
  });

  it("ftsTokenStream / buildFtsMatchQuery：emoji 编码与拉丁前缀", () => {
    expect(ftsTokenStream("搜索 🚀 react")).toContain("u1f680");
    expect(buildFtsMatchQuery("rea")).toBe("rea*");
    expect(buildFtsMatchQuery("组件化")).toContain('"组件"');
    expect(buildFtsMatchQuery("  ")).toBeNull();
  });

  it("管理器：非常规 vaultId 哈希文件名（路径不可逃逸）+ 跨库合并查询", async () => {
    const manager = new DesktopSearchIndexManager(dir);
    const hashed = searchIndexFilePath(dir, "../evil");
    expect(hashed.startsWith(`${dir}/t-`)).toBe(true);
    expect(hashed).not.toContain("..");
    const a = manager.forVault("v-a");
    const b = manager.forVault("v-b");
    await a.upsert(
      row({ pageId: "na", vaultId: "v-a", bodyText: "跨库关键词" }),
    );
    await b.upsert(
      row({ pageId: "nb", vaultId: "v-b", bodyText: "跨库关键词" }),
    );
    const merged = await manager.searchAll({ query: "跨库关键词" });
    expect(merged.map((r) => r.pageId).sort()).toEqual(["na", "nb"]);
    manager.closeAll();
  });
});
