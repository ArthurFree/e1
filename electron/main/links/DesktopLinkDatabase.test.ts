// @vitest-environment node
/**
 * R010 Stage 3（§7/§17）：DesktopLinkDatabase 单测——
 * 损坏自愈（备份 + 重建）、link_* 版本命名空间不兼容重建、
 * 与搜索表组共库单连接（一方触发文件级自愈后另一方重初始化）、
 * versionToken 去重跳过。
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildExtractedLink } from "../../../shared/links/extractDocumentLinks.js";
import type { LinkIndexDocument } from "../../../shared/links/LinkIndex.js";
import { VaultIndexConnection } from "../index/VaultIndexConnection.js";
import { DesktopSearchDatabase } from "../search/DesktopSearchDatabase.js";
import { DesktopLinkDatabase } from "./DesktopLinkDatabase.js";

const VAULT = "v-unit";

function doc(
  partial: Partial<LinkIndexDocument> & { noteKey: string },
): LinkIndexDocument {
  return {
    vaultId: VAULT,
    stableNoteId: null,
    relativePath: `${partial.noteKey}.md`,
    title: partial.noteKey,
    versionToken: `sha256:${partial.noteKey}`,
    links: [],
    ...partial,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-link-db-"));
  file = join(dir, "v-unit.sqlite");
});

describe("DesktopLinkDatabase", () => {
  it("upsert/查询往返 + 状态机 ready；versionToken 未变的重复提交跳过", async () => {
    const db = new DesktopLinkDatabase(file);
    expect(db.getStatus(VAULT).state).toBe("missing");
    await db.upsertDocument(
      doc({
        noteKey: "01A",
        stableNoteId: "01A",
        relativePath: "甲.md",
        links: [buildExtractedLink("乙.md", "到乙", "甲.md")!],
      }),
    );
    expect(db.getStatus(VAULT)).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    // 目标不存在 → broken 落库。
    expect(await db.getOutgoing(VAULT, "01A")).toEqual([
      expect.objectContaining({ label: "到乙", broken: true }),
    ]);
    // versionToken + 路径未变：重复提交跳过（不翻倍、不出错）。
    await db.upsertDocument(
      doc({
        noteKey: "01A",
        stableNoteId: "01A",
        relativePath: "甲.md",
        links: [buildExtractedLink("乙.md", "到乙", "甲.md")!],
      }),
    );
    expect(await db.getOutgoing(VAULT, "01A")).toHaveLength(1);
    db.close();
  });

  it("损坏库文件：备份 .corrupt-* 后重建空库（status=missing，可再索引）", async () => {
    await writeFile(file, "这不是 sqlite 数据库", "utf8");
    const db = new DesktopLinkDatabase(file, () => 42);
    await db.upsertDocument(doc({ noteKey: "n1", title: "重建后可用" }));
    expect(await readdir(dir)).toContain("v-unit.sqlite.corrupt-42");
    expect(await readFile(join(dir, "v-unit.sqlite.corrupt-42"), "utf8")).toBe(
      "这不是 sqlite 数据库",
    );
    expect(db.getStatus(VAULT)).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    db.close();
  });

  it("link_* 格式版本不兼容：整库重建（链接索引清空，搜索 meta 不动）", async () => {
    const db = new DesktopLinkDatabase(file, () => 43);
    await db.upsertDocument(doc({ noteKey: "n1" }));
    db.close();
    // 篡改本表组版本标记模拟不兼容。
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw
      .prepare("UPDATE index_meta SET value = ? WHERE key = ?")
      .run("999", "link_index_format_version");
    raw.close();
    const reopened = new DesktopLinkDatabase(file, () => 44);
    expect(await reopened.getOutgoing(VAULT, "n1")).toEqual([]);
    expect(reopened.getStatus(VAULT).state).toBe("missing");
    expect(await readdir(dir)).toContain("v-unit.sqlite.corrupt-44");
    reopened.close();
  });

  it("共库单连接：Search 与 Link 表组同库工作，互不占锁", async () => {
    const connection = new VaultIndexConnection(file);
    const search = new DesktopSearchDatabase(connection);
    const link = new DesktopLinkDatabase(connection);
    await search.upsert({
      pageId: "01A",
      vaultId: VAULT,
      stableNoteId: "01A",
      relativePath: "甲.md",
      title: "甲",
      tags: [],
      bodyText: "共库正文",
      createdAt: null,
      updatedAt: null,
      versionToken: "sha256:s",
    });
    await link.upsertDocument(
      doc({
        noteKey: "01A",
        stableNoteId: "01A",
        relativePath: "甲.md",
        title: "甲",
      }),
    );
    expect(
      (await search.search({ vaultId: VAULT, query: "共库" })).length,
    ).toBe(1);
    expect(link.getStatus(VAULT)).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    // meta 命名空间各自独立。
    const { DatabaseSync } = await import("node:sqlite");
    connection.close();
    const raw = new DatabaseSync(file);
    const keys = (
      raw.prepare("SELECT key FROM index_meta ORDER BY key").all() as {
        key: string;
      }[]
    ).map((r) => r.key);
    expect(keys).toEqual([
      "index_format_version",
      "link_index_format_version",
      "link_schema_version",
      "schema_version",
    ]);
    raw.close();
  });

  it("共库自愈：链接表组触发文件级恢复后，搜索表组重初始化（派生数据同生共死）", async () => {
    const connection = new VaultIndexConnection(file, () => 45);
    const search = new DesktopSearchDatabase(connection);
    const link = new DesktopLinkDatabase(connection);
    await search.upsert({
      pageId: "01A",
      vaultId: VAULT,
      stableNoteId: "01A",
      relativePath: "甲.md",
      title: "甲",
      tags: [],
      bodyText: "会被清空的搜索内容",
      createdAt: null,
      updatedAt: null,
      versionToken: "sha256:s",
    });
    connection.close();
    await writeFile(file, " corrupted ", "utf8");
    // 链接表组先发现损坏 → 文件级备份重建。
    await link.upsertDocument(doc({ noteKey: "n1" }));
    expect(await readdir(dir)).toContain("v-unit.sqlite.corrupt-45");
    // 搜索表组经 generation 失效重初始化：数据随文件重建清空（可重建）。
    expect(await search.search({ vaultId: VAULT, query: "清空" })).toEqual([]);
    expect(search.getStatus(VAULT)).toEqual({
      state: "ready",
      indexedDocuments: 0,
    });
    connection.close();
  });
});
