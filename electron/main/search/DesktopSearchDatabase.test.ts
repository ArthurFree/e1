// @vitest-environment node
/**
 * R008 Stage 4（§11.2/§11.3/§13.2/§13.3）：DesktopSearchDatabase
 * （node:sqlite adapter）测试——真实 node:sqlite + 临时目录。
 *
 * 覆盖：建库/schema/版本写入、upsert 覆盖与批量事务、FTS bigram 召回
 * （中文/英文）、instr 兜底召回（纯 emoji 查询）、remove/clear、跨
 * 实例持久化、损坏文件自愈（改名 .corrupt-* + 新建）、版本不兼容重建、
 * vaultId 文件名派生（transient 含冒号 id 走 sha256）。
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { SearchDocument } from "../../../shared/search/model.js";
import {
  DesktopSearchDatabase,
  SEARCH_DB_FORMAT_VERSION,
  SEARCH_DB_SCHEMA_VERSION,
  searchIndexFileName,
} from "./DesktopSearchDatabase.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e1-search-db-"));
  tempDirs.push(dir);
  return dir;
}

function doc(
  pageId: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return {
    pageId,
    vaultId: "vault-a",
    stableNoteId: null,
    relativePath: `notes/${pageId}.md`,
    title: "",
    tags: [],
    bodyText: "",
    createdAt: null,
    updatedAt: null,
    versionToken: `v1-${pageId}`,
    ...overrides,
  };
}

describe("searchIndexFileName", () => {
  it("安全片段 vaultId 直接作文件名", () => {
    expect(searchIndexFileName("01JE2EVAULT00000000000abc")).toBe(
      "01JE2EVAULT00000000000abc.sqlite",
    );
  });

  it("transient:<uuid> 等含非法字符 id 走确定性 sha256 派生名", () => {
    const name = searchIndexFileName("transient:abcd-1234");
    expect(name).toMatch(/^v-[0-9a-f]{24}\.sqlite$/);
    // 确定性：同 id 同名；不同 id 不同名。
    expect(searchIndexFileName("transient:abcd-1234")).toBe(name);
    expect(searchIndexFileName("transient:abcd-1235")).not.toBe(name);
  });
});

describe("DesktopSearchDatabase", () => {
  it("新建库：createdFresh + 版本写入 + 空计数", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    expect(db.createdFresh).toBe(true);
    expect(db.countDocuments()).toBe(0);
    const meta = new DatabaseSync(join(baseDir, "vault-a.sqlite"));
    const read = meta.prepare("SELECT value FROM index_meta WHERE key = ?");
    expect((read.get("schemaVersion") as { value: string }).value).toBe(
      SEARCH_DB_SCHEMA_VERSION,
    );
    expect((read.get("indexFormatVersion") as { value: string }).value).toBe(
      SEARCH_DB_FORMAT_VERSION,
    );
    meta.close();
    db.close();
  });

  it("upsert 后 FTS 召回：中文标题/正文与英文大小写归一", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([
      doc("p1", { title: "部署手册", bodyText: "部署前确认环境变量。" }),
      doc("p2", { title: "React Notes", bodyText: "组件化心得。" }),
      doc("p3", { title: "无关", bodyText: "周六出发。" }),
    ]);
    expect(db.countDocuments()).toBe(3);
    expect(db.recall("部署", 100).map((d) => d.pageId).sort()).toEqual([
      "p1",
    ]);
    // 英文大小写：索引与查询两侧均 JS 归一化。
    expect(db.recall("react", 100).map((d) => d.pageId)).toEqual(["p2"]);
    db.close();
  });

  it("长词子串召回：reaction 命中查询 react（bigram 覆盖）", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([doc("p1", { bodyText: "reaction 与重渲染" })]);
    expect(db.recall("react", 100).map((d) => d.pageId)).toEqual(["p1"]);
    db.close();
  });

  it("纯 emoji 查询回退 instr 召回", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([doc("p1", { bodyText: "周六出发 🚀，记得带相机。" })]);
    expect(db.recall("🚀", 100).map((d) => d.pageId)).toEqual(["p1"]);
    expect(db.recall("🧳", 100)).toEqual([]);
    db.close();
  });

  it("同 pageId upsert 覆盖：旧文本立即消失", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([doc("p1", { bodyText: "旧文本 alpha-old" })]);
    expect(db.recall("alpha-old", 100)).toHaveLength(1);
    db.upsertDocuments([
      doc("p1", { bodyText: "新文本 beta-new", versionToken: "v2-p1" }),
    ]);
    expect(db.recall("alpha-old", 100)).toEqual([]);
    expect(db.recall("beta-new", 100).map((d) => d.pageId)).toEqual(["p1"]);
    expect(db.countDocuments()).toBe(1);
    db.close();
  });

  it("removeDocument 移除命中；缺失条目 no-op", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([doc("p1", { title: "部署手册" })]);
    db.removeDocument("p1");
    expect(db.recall("部署", 100)).toEqual([]);
    expect(db.countDocuments()).toBe(0);
    db.removeDocument("p1");
    db.removeDocument("missing");
    db.close();
  });

  it("clearAll 清空派生内容", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    db.upsertDocuments([doc("p1", { title: "部署手册" })]);
    db.clearAll();
    expect(db.countDocuments()).toBe(0);
    expect(db.recall("部署", 100)).toEqual([]);
    db.close();
  });

  it("源文档字段完整往返（tags/stableNoteId/时间戳/版本令牌）", async () => {
    const baseDir = await makeBaseDir();
    const db = DesktopSearchDatabase.open(baseDir, "vault-a");
    const source = doc("p1", {
      stableNoteId: "stable-1",
      title: "部署手册",
      tags: ["运维", "部署"],
      bodyText: "部署前确认。",
      createdAt: 1_757_000_000_000,
      updatedAt: 1_757_000_060_000,
      versionToken: "sha256:abc",
    });
    db.upsertDocuments([source]);
    expect(db.listDocuments()).toEqual([source]);
    db.close();
  });

  it("关闭后重开：内容持久、createdFresh=false", async () => {
    const baseDir = await makeBaseDir();
    const first = DesktopSearchDatabase.open(baseDir, "vault-a");
    first.upsertDocuments([doc("p1", { title: "部署手册" })]);
    first.close();
    const second = DesktopSearchDatabase.open(baseDir, "vault-a");
    expect(second.createdFresh).toBe(false);
    expect(second.countDocuments()).toBe(1);
    expect(second.recall("部署", 100).map((d) => d.pageId)).toEqual(["p1"]);
    second.close();
  });

  it("损坏文件自愈：改名 .corrupt-* 备份后新建可用空库", async () => {
    const baseDir = await makeBaseDir();
    await writeFile(
      join(baseDir, "vault-a.sqlite"),
      "这不是 SQLite 数据库文件",
      "utf8",
    );
    const db = DesktopSearchDatabase.open(baseDir, "vault-a", {
      now: () => 1_800_000_000_000,
    });
    expect(db.createdFresh).toBe(true);
    expect(db.countDocuments()).toBe(0);
    db.upsertDocuments([doc("p1", { title: "部署手册" })]);
    expect(db.recall("部署", 100)).toHaveLength(1);
    const files = await readdir(baseDir);
    expect(
      files.some((name) => name.startsWith("vault-a.sqlite.corrupt-")),
    ).toBe(true);
    db.close();
  });

  it("版本不兼容：旧库改名备份后按派生数据重建", async () => {
    const baseDir = await makeBaseDir();
    const first = DesktopSearchDatabase.open(baseDir, "vault-a");
    first.upsertDocuments([doc("p1", { title: "部署手册" })]);
    first.close();
    // 模拟旧版本库（format 版本落后）。
    const raw = new DatabaseSync(join(baseDir, "vault-a.sqlite"));
    raw.prepare("UPDATE index_meta SET value = ? WHERE key = ?").run(
      "0",
      "indexFormatVersion",
    );
    raw.close();
    const second = DesktopSearchDatabase.open(baseDir, "vault-a");
    expect(second.createdFresh).toBe(true);
    expect(second.countDocuments()).toBe(0);
    const files = await readdir(baseDir);
    expect(
      files.some((name) => name.startsWith("vault-a.sqlite.corrupt-")),
    ).toBe(true);
    second.close();
  });
});
