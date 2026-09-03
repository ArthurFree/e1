/**
 * R010 Stage 3（§7/§11/§17）：Desktop 链接索引 SQLite 表组——
 * 与全文搜索共库（同一 VaultIndexConnection 单连接，避免 SQLITE_BUSY），
 * meta 版本用独立命名空间（link_schema_version / link_index_format_version）。
 *
 * 表结构按 §17（links 表 + links_source/links_target/links_broken 索引），
 * 身份列对齐搜索 note_key 规则（stableNoteId ?? "path:<relativePath>"，
 * 命名为 source_note_key/target_note_key 而非文档字面 source_page_id）；
 * 另加 link_docs 表（文档快照：标题/路径/版本 + links_json 提取原文），
 * 支撑 Backlink.sourceTitle、目标解析快照与 relocate 重锚定。
 *
 * 解析/裁决与内存参照实现逐点一致（同一 shared/links/resolveLinks，
 * 契约套件 shared/links/linkIndexContract.ts 双实现强制）：
 * - internal 目标路径在快照（link_docs）中解析不到 → broken=1 落库；
 * - 目标 upsert / relocate 落位 / rebuild 时重解析自动恢复；
 * - 源文档 relocate：身份保持只改路径，其出站链接按新位置重新锚定。
 *
 * 派生数据原则（LINK-03）：损坏/版本不兼容一律经连接持有者备份重建，
 * 绝不回写 Markdown。
 */
import type { DatabaseSync } from "node:sqlite";
import type { SearchIndexStatus } from "../../../shared/ipc/contracts.js";
import type { LinkIndexDocument } from "../../../shared/links/LinkIndex.js";
import type { ExtractedLink } from "../../../shared/links/extractDocumentLinks.js";
import { buildExtractedLink } from "../../../shared/links/extractDocumentLinks.js";
import { resolveExtractedLinks } from "../../../shared/links/resolveLinks.js";
import type { LinkIndexLookup } from "../../../shared/links/resolveLinks.js";
import type { Backlink, DocumentLink } from "../../../shared/links/types.js";
import { VaultIndexConnection } from "../index/VaultIndexConnection.js";

/** links 表组 schema / 索引格式版本（不兼容即整库重建，§13.2 同口径）。 */
const LINK_SCHEMA_VERSION = "1";
const LINK_INDEX_FORMAT_VERSION = "1";
/** 单事务批量 upsert 的文档数（与搜索同口径，§11.6 区间）。 */
const BATCH_SIZE = 200;

const DDL = `
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link_docs (
  note_key TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  stable_note_id TEXT,
  relative_path TEXT NOT NULL,
  title TEXT NOT NULL,
  version_token TEXT NOT NULL,
  links_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS link_docs_vault_path ON link_docs(vault_id, relative_path);
CREATE TABLE IF NOT EXISTS links (
  source_note_key TEXT NOT NULL,
  target_note_key TEXT,
  target_path TEXT,
  href TEXT NOT NULL,
  label TEXT NOT NULL,
  fragment TEXT,
  link_kind TEXT NOT NULL,
  broken INTEGER NOT NULL,
  source_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_source ON links(source_note_key);
CREATE INDEX IF NOT EXISTS links_target ON links(target_note_key);
CREATE INDEX IF NOT EXISTS links_broken ON links(broken);
`;

interface LinkDocRow {
  note_key: string;
  vault_id: string;
  stable_note_id: string | null;
  relative_path: string;
  title: string;
  version_token: string;
  links_json: string;
}

interface LinkRow {
  source_note_key: string;
  target_note_key: string | null;
  target_path: string | null;
  href: string;
  label: string;
  fragment: string | null;
  link_kind: string;
  broken: number;
  source_version: string;
}

function toDocumentLink(row: LinkRow): DocumentLink {
  return {
    sourcePageId: row.source_note_key,
    href: row.href,
    label: row.label,
    kind: row.link_kind as DocumentLink["kind"],
    targetPageId: row.target_note_key,
    targetRelativePath: row.target_path,
    fragment: row.fragment,
    broken: row.broken === 1,
    sourceVersion: row.source_version,
  };
}

export class DesktopLinkDatabase {
  private readonly connection: VaultIndexConnection;
  /** 本表组完成初始化的连接代数（与连接不一致时需重初始化）。 */
  private initializedGeneration = -1;
  private status: SearchIndexStatus = { state: "missing" };

  /**
   * filePath 形式：独立连接（测试/单独使用）；VaultIndexConnection 形式：
   * 与搜索表组共用 per-vault 单连接（R010 §17 共库方案）。
   */
  constructor(
    file: string | VaultIndexConnection,
    now: () => number = () => Date.now(),
  ) {
    this.connection =
      typeof file === "string" ? new VaultIndexConnection(file, now) : file;
  }

  /** 打开（必要时创建）数据库；损坏/版本不兼容 → 备份后重建（LINK-03）。 */
  private async open(): Promise<DatabaseSync> {
    try {
      const db = await this.connection.open();
      if (this.initializedGeneration === this.connection.currentGeneration) {
        return db;
      }
      db.exec(DDL);
      this.assertFormatVersion(db);
      const count = (
        db.prepare("SELECT COUNT(*) AS c FROM link_docs").get() as {
          c: number;
        }
      ).c;
      this.status = { state: "ready", indexedDocuments: count };
      this.initializedGeneration = this.connection.currentGeneration;
      return db;
    } catch (error) {
      // 损坏/版本不兼容：文件级自愈（备份 .corrupt-<ts>）→ 重建空库。
      await this.connection.recoverCorrupt(error);
      const fresh = await this.connection.open();
      fresh.exec(DDL);
      this.writeFormatVersion(fresh);
      this.status = { state: "missing" };
      this.initializedGeneration = this.connection.currentGeneration;
      return fresh;
    }
  }

  private assertFormatVersion(meta: DatabaseSync): void {
    const read = (key: string) =>
      (
        meta.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
          { value: string } | undefined
      )?.value;
    if (read("link_schema_version") === undefined) {
      // 全新库（或仅有搜索表组）：写入本表组版本标记。
      this.writeFormatVersion(meta);
      return;
    }
    if (
      read("link_schema_version") !== LINK_SCHEMA_VERSION ||
      read("link_index_format_version") !== LINK_INDEX_FORMAT_VERSION
    ) {
      throw new Error("链接索引格式版本不兼容");
    }
  }

  private writeFormatVersion(meta: DatabaseSync): void {
    const upsert = meta.prepare(
      "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)",
    );
    upsert.run("link_schema_version", LINK_SCHEMA_VERSION);
    upsert.run("link_index_format_version", LINK_INDEX_FORMAT_VERSION);
  }

  getStatus(vaultId: string): SearchIndexStatus {
    // DB 文件已按 vault 隔离，参数仅作调用方语义对齐（与 port 形状一致）。
    void vaultId;
    return this.status;
  }

  /** 快照查询面（resolveExtractedLinks 的目标解析来源）。 */
  private lookup(db: DatabaseSync, vaultId: string): LinkIndexLookup {
    const byPathStmt = db.prepare(
      "SELECT note_key, relative_path FROM link_docs WHERE vault_id = ? AND relative_path = ?",
    );
    const byKeyStmt = db.prepare(
      "SELECT note_key, relative_path FROM link_docs WHERE note_key = ?",
    );
    const map = (
      row: { note_key: string; relative_path: string } | undefined,
    ): { noteKey: string; relativePath: string } | null =>
      row ? { noteKey: row.note_key, relativePath: row.relative_path } : null;
    return {
      byPath: (relativePath) =>
        map(
          byPathStmt.get(vaultId, relativePath) as
            { note_key: string; relative_path: string } | undefined,
        ),
      byKey: (noteKey) =>
        map(
          byKeyStmt.get(noteKey) as
            { note_key: string; relative_path: string } | undefined,
        ),
    };
  }

  /** 把解析后的链接行写入 links 表（调用方须已开启事务）。 */
  private insertLinks(
    db: DatabaseSync,
    document: LinkIndexDocument,
    links: ExtractedLink[],
  ): void {
    const insert = db.prepare(
      `INSERT INTO links(
        source_note_key, target_note_key, target_path, href, label,
        fragment, link_kind, broken, source_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const resolved = resolveExtractedLinks(
      document,
      links,
      this.lookup(db, document.vaultId),
    );
    for (const link of resolved) {
      insert.run(
        link.sourcePageId,
        link.targetPageId,
        link.targetRelativePath,
        link.href,
        link.label,
        link.fragment,
        link.kind,
        link.broken ? 1 : 0,
        link.sourceVersion,
      );
    }
  }

  /**
   * 单文档 upsert（幂等）：替换文档快照 + 重解析出站链接；
   * 本路径上此前 broken 的链接随目标到达自动恢复。
   */
  async upsertDocument(document: LinkIndexDocument): Promise<void> {
    const db = await this.open();
    const existing = db
      .prepare(
        "SELECT version_token, relative_path FROM link_docs WHERE note_key = ?",
      )
      .get(document.noteKey) as
      { version_token: string; relative_path: string } | undefined;
    if (
      existing &&
      existing.version_token === document.versionToken &&
      existing.relative_path === document.relativePath
    ) {
      return; // versionToken 未变的重复提交跳过（§12.3 同口径）。
    }
    db.exec("BEGIN");
    try {
      this.runUpsert(db, document);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
    this.refreshReadyCount(db);
  }

  /** upsert 内核（调用方须已开启事务；rebuild 批量复用）。 */
  private runUpsert(db: DatabaseSync, document: LinkIndexDocument): void {
    db.prepare("DELETE FROM links WHERE source_note_key = ?").run(
      document.noteKey,
    );
    db.prepare(
      `INSERT OR REPLACE INTO link_docs(
        note_key, vault_id, stable_note_id, relative_path, title,
        version_token, links_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      document.noteKey,
      document.vaultId,
      document.stableNoteId,
      document.relativePath,
      document.title,
      document.versionToken,
      JSON.stringify(document.links),
    );
    this.insertLinks(db, document, document.links);
    // 恢复：指向本路径的 broken 链接随目标到达翻回（重解析的副产品）。
    db.prepare(
      "UPDATE links SET target_note_key = ?, broken = 0 WHERE broken = 1 AND target_path = ?",
    ).run(document.noteKey, document.relativePath);
  }

  /** 全量重建：清空表组 + 两遍入库（先快照后解析）+ 分批事务让出。 */
  async rebuild(
    documents: Iterable<LinkIndexDocument> | AsyncIterable<LinkIndexDocument>,
  ): Promise<void> {
    const db = await this.open();
    this.status = { state: "building" };
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM links");
      db.exec("DELETE FROM link_docs");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
    // 第一遍：登记全部文档快照（目标可能在批次后出现，先不解析）。
    let count = 0;
    let batch: LinkIndexDocument[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const insertDoc = db.prepare(
        `INSERT OR REPLACE INTO link_docs(
          note_key, vault_id, stable_note_id, relative_path, title,
          version_token, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec("BEGIN");
      try {
        for (const document of batch) {
          insertDoc.run(
            document.noteKey,
            document.vaultId,
            document.stableNoteId,
            document.relativePath,
            document.title,
            document.versionToken,
            JSON.stringify(document.links),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        this.status = { state: "degraded", reason: String(error) };
        throw error;
      }
      count += batch.length;
      batch = [];
      this.status = { state: "building", progress: count };
      // 让出事件循环（大数据量重建不阻塞 Main 其它 IPC）。
      await new Promise((resolve) => setImmediate(resolve));
    };
    for await (const document of documents) {
      batch.push(document);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    // 第二遍：快照齐全后统一解析出站链接。
    const docs = db
      .prepare("SELECT * FROM link_docs")
      .all() as unknown as LinkDocRow[];
    db.exec("BEGIN");
    try {
      for (const row of docs) {
        const document: LinkIndexDocument = {
          noteKey: row.note_key,
          vaultId: row.vault_id,
          stableNoteId: row.stable_note_id,
          relativePath: row.relative_path,
          title: row.title,
          versionToken: row.version_token,
          links: JSON.parse(row.links_json) as ExtractedLink[],
        };
        this.insertLinks(db, document, document.links);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
    this.status = { state: "ready", indexedDocuments: count };
  }

  /** 按 note_key 删除（幂等）；指向它的链接翻 broken。 */
  async remove(noteKey: string): Promise<void> {
    const db = await this.open();
    db.exec("BEGIN");
    try {
      // 指向被删文档的链接翻 broken（target_path 保留供恢复）。
      db.prepare(
        "UPDATE links SET target_note_key = NULL, broken = 1 WHERE target_note_key = ?",
      ).run(noteKey);
      db.prepare("DELETE FROM links WHERE source_note_key = ?").run(noteKey);
      db.prepare("DELETE FROM link_docs WHERE note_key = ?").run(noteKey);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
    this.refreshReadyCount(db);
  }

  /** 按相对路径删除（文件已消失的场景；幂等）。 */
  async removeByPath(vaultId: string, relativePath: string): Promise<void> {
    const db = await this.open();
    const row = db
      .prepare(
        "SELECT note_key FROM link_docs WHERE vault_id = ? AND relative_path = ?",
      )
      .get(vaultId, relativePath) as { note_key: string } | undefined;
    if (row) await this.remove(row.note_key);
  }

  /**
   * 移动/重命名：身份保持只改路径（path 身份改键）；指向本文件的链接
   * 同步更新，等待本路径落位的 broken 链接恢复；源文档出站链接按新
   * 位置重新锚定（重跑提取器归一 + 快照解析）。目标不存在为 no-op。
   */
  async relocate(input: {
    vaultId: string;
    noteKey?: string;
    fromRelativePath: string;
    toRelativePath: string;
  }): Promise<void> {
    const db = await this.open();
    const row = (
      input.noteKey
        ? db
            .prepare("SELECT * FROM link_docs WHERE note_key = ?")
            .get(input.noteKey)
        : db
            .prepare(
              "SELECT * FROM link_docs WHERE vault_id = ? AND relative_path = ?",
            )
            .get(input.vaultId, input.fromRelativePath)
    ) as LinkDocRow | undefined;
    if (!row) return;
    const oldKey = row.note_key;
    const newKey = row.stable_note_id ?? `path:${input.toRelativePath}`;
    db.exec("BEGIN");
    try {
      // 指向本文件的链接随移动更新（身份跟随文件）。
      db.prepare(
        "UPDATE links SET target_note_key = ?, target_path = ?, broken = 0 WHERE target_note_key = ?",
      ).run(newKey, input.toRelativePath, oldKey);
      // 等待本路径落位的 broken 链接恢复。
      db.prepare(
        "UPDATE links SET target_note_key = ?, broken = 0 WHERE broken = 1 AND target_path = ?",
      ).run(newKey, input.toRelativePath);
      // 文档行：身份保持（stable id 不变；path 身份改键）。
      db.prepare(
        "UPDATE link_docs SET note_key = ?, relative_path = ? WHERE note_key = ?",
      ).run(newKey, input.toRelativePath, oldKey);
      if (newKey !== oldKey) {
        db.prepare(
          "UPDATE links SET source_note_key = ? WHERE source_note_key = ?",
        ).run(newKey, oldKey);
      }
      // 源文档出站链接重锚定：相对 href 以新目录为基准重算目标路径。
      const document: LinkIndexDocument = {
        noteKey: newKey,
        vaultId: row.vault_id,
        stableNoteId: row.stable_note_id,
        relativePath: input.toRelativePath,
        title: row.title,
        versionToken: row.version_token,
        links: JSON.parse(row.links_json) as ExtractedLink[],
      };
      const reanchored = document.links.map((extracted) => {
        // Editor 节点引用（knownTargetPageId 身份）不受移动影响。
        if (extracted.href === "") return extracted;
        return (
          buildExtractedLink(
            extracted.href,
            extracted.label,
            input.toRelativePath,
          ) ?? extracted
        );
      });
      db.prepare("DELETE FROM links WHERE source_note_key = ?").run(newKey);
      this.insertLinks(db, document, reanchored);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
  }

  /** 单篇文档的出站链接（rowid = 提取顺序）。 */
  async getOutgoing(vaultId: string, noteKey: string): Promise<DocumentLink[]> {
    const db = await this.open();
    const rows = db
      .prepare(
        `SELECT l.* FROM links l
         JOIN link_docs d ON d.note_key = l.source_note_key
         WHERE l.source_note_key = ? AND d.vault_id = ? ORDER BY l.rowid`,
      )
      .all(noteKey, vaultId) as unknown as LinkRow[];
    return rows.map(toDocumentLink);
  }

  /** 谁引用了目标页面（source_note_key/href 稳定排序）。 */
  async getBacklinks(vaultId: string, noteKey: string): Promise<Backlink[]> {
    const db = await this.open();
    const rows = db
      .prepare(
        `SELECT l.source_note_key, l.href, d.title AS source_title
         FROM links l JOIN link_docs d ON d.note_key = l.source_note_key
         WHERE l.target_note_key = ? AND l.broken = 0 AND d.vault_id = ?
         ORDER BY l.source_note_key, l.href`,
      )
      .all(noteKey, vaultId) as unknown as {
      source_note_key: string;
      href: string;
      source_title: string;
    }[];
    return rows.map((row) => ({
      sourcePageId: row.source_note_key,
      targetPageId: noteKey,
      sourceTitle: row.source_title,
      snippet: null,
      href: row.href,
    }));
  }

  /** 当前快照中全部 broken 链接（source_note_key + 提取顺序稳定）。 */
  async getBrokenLinks(vaultId: string): Promise<DocumentLink[]> {
    const db = await this.open();
    const rows = db
      .prepare(
        `SELECT l.* FROM links l
         JOIN link_docs d ON d.note_key = l.source_note_key
         WHERE l.broken = 1 AND d.vault_id = ?
         ORDER BY l.source_note_key, l.rowid`,
      )
      .all(vaultId) as unknown as LinkRow[];
    return rows.map(toDocumentLink);
  }

  private refreshReadyCount(db: DatabaseSync): void {
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM link_docs").get() as { c: number }
    ).c;
    this.status = { state: "ready", indexedDocuments: count };
  }

  close(): void {
    // 连接持有者优先：共库场景下由 Manager 统一 closeAll（重复 close 无害）。
    this.connection.close();
    this.initializedGeneration = -1;
  }
}
