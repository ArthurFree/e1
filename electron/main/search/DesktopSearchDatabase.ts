/**
 * R008 Stage 4（§11.1–§11.4/§13.2/§13.3）：Desktop 全文搜索派生索引的
 * SQLite 存储层（node:sqlite adapter，R8-04 的数据库隔离边界）。
 *
 * 职责（且仅这些）：打开/创建 per-vault 索引库、schema 与版本管理、
 * 损坏自愈、批量 upsert/remove/clear、候选召回（FTS5 bigram 优先，
 * instr 子串兜底）。文档来源（Vault 扫描）与状态机编排在上层
 * DesktopSearchService；精确排序在契约层 shared/search/ranking.ts
 * （「存储召回 + 契约层精排」，中文方案 B）。
 *
 * 库位置（§11.2）：userData/search-index/<vaultId 派生文件名>.sqlite——
 * 设备级派生状态，不进 Vault、不写 Markdown（R8-03）。vaultId 常规为
 * 文件名片段安全字符（ULID/uuid）直接作文件名；transient 会话 id 形如
 * "transient:<uuid>" 含冒号（Windows 文件名非法），统一退化为
 * sha256 派生名（确定性、无路径逃逸面，与 VaultStateStore 白名单同
 * 口径的纵深防御）。
 *
 * 损坏/版本不兼容恢复（§13.2/§13.3）：打开/schema/版本检查任一失败 →
 * 关闭 → 原文件改名 <file>.corrupt-<时间戳>（字节保留，不静默丢弃）→
 * 新建空库。派生索引优先 rebuild，不做迁移；createdFresh 标记交给上层
 * 触发正文真相重扫。打开永不抛错阻断 Vault 打开。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchDocument } from "../../../shared/search/model.js";
import {
  normalizeSearchText,
  tokenizeForSearchIndex,
  tokenizeForSearchQuery,
} from "./searchTokens.js";

/** schemaVersion / indexFormatVersion（§13.2）：不兼容即整库重建。 */
export const SEARCH_DB_SCHEMA_VERSION = "1";
export const SEARCH_DB_FORMAT_VERSION = "1";

/** 与 DesktopVaultStateStore 同口径的文件名片段白名单。 */
const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * vaultId → 索引库文件名。安全片段直接用；否则（如 transient:<uuid>）
 * sha256 派生确定性文件名，拒绝一切路径分隔符/逃逸段进入文件路径。
 */
export function searchIndexFileName(vaultId: string): string {
  if (SAFE_FILE_STEM.test(vaultId)) return `${vaultId}.sqlite`;
  const hash = createHash("sha256").update(vaultId).digest("hex").slice(0, 24);
  return `v-${hash}.sqlite`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  page_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  stable_note_id TEXT,
  relative_path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  body_text TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  normalized_tags TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  version_token TEXT NOT NULL
);
`;

export interface DesktopSearchDatabaseOptions {
  now?: () => number;
}

export class DesktopSearchDatabase {
  private constructor(
    private readonly handle: DatabaseSync,
    /** FTS5 可用性（环境缺 FTS5 编译选项时整体回退 instr 召回）。 */
    private readonly fts: boolean,
    /** true：本次打开新建了空库（含损坏自愈后重建）——上层需从正文真相回填。 */
    readonly createdFresh: boolean,
  ) {}

  /** 打开（必要时创建/自愈）vault 索引库；永不抛错。 */
  static open(
    baseDir: string,
    vaultId: string,
    options: DesktopSearchDatabaseOptions = {},
  ): DesktopSearchDatabase {
    mkdirSync(baseDir, { recursive: true });
    const path = join(baseDir, searchIndexFileName(vaultId));
    const existed = existsSync(path);
    try {
      return DesktopSearchDatabase.openAt(path, !existed);
    } catch {
      // 损坏/schema 不兼容/版本不兼容：改名备份后新建（§13.3）。
      const backup = `${path}.corrupt-${(options.now ?? (() => Date.now()))()}`;
      try {
        renameSync(path, backup);
      } catch {
        // 备份失败仍继续新建——索引是派生数据，绝不允许阻断开库。
      }
      return DesktopSearchDatabase.openAt(path, true);
    }
  }

  private static openAt(
    path: string,
    createdFresh: boolean,
  ): DesktopSearchDatabase {
    const handle = new DatabaseSync(path);
    try {
      try {
        handle.exec("PRAGMA journal_mode = WAL");
      } catch {
        // WAL 不可用（个别文件系统）回退默认日志模式——派生索引可接受。
      }
      handle.exec(SCHEMA_SQL);
      let fts = true;
      try {
        handle.exec(
          "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(tokens, tokenize='unicode61')",
        );
      } catch {
        // 环境 SQLite 未编译 FTS5：跳过虚拟表，召回整体走 instr 兜底。
        fts = false;
      }
      DesktopSearchDatabase.ensureVersion(handle);
      return new DesktopSearchDatabase(handle, fts, createdFresh);
    } catch (error) {
      // 失败必须关闭句柄——否则 Windows 下占用文件导致改名备份失败。
      try {
        handle.close();
      } catch {
        // 关闭失败忽略，恢复流程继续。
      }
      throw error;
    }
  }

  /** 版本检查：新库写入当前版本；旧库版本不符即抛（调用方走自愈重建）。 */
  private static ensureVersion(handle: DatabaseSync): void {
    const read = handle.prepare("SELECT value FROM index_meta WHERE key = ?");
    const schemaVersion = (read.get("schemaVersion") as
      | { value: string }
      | undefined)?.value;
    const formatVersion = (read.get("indexFormatVersion") as
      | { value: string }
      | undefined)?.value;
    if (schemaVersion === undefined && formatVersion === undefined) {
      const write = handle.prepare(
        "INSERT INTO index_meta (key, value) VALUES (?, ?)",
      );
      write.run("schemaVersion", SEARCH_DB_SCHEMA_VERSION);
      write.run("indexFormatVersion", SEARCH_DB_FORMAT_VERSION);
      return;
    }
    if (
      schemaVersion !== SEARCH_DB_SCHEMA_VERSION ||
      formatVersion !== SEARCH_DB_FORMAT_VERSION
    ) {
      throw new Error(
        `搜索索引版本不兼容（schema=${schemaVersion ?? "?"}, format=${formatVersion ?? "?"}），按派生数据重建`,
      );
    }
  }

  /** 批量 upsert（单事务；同 pageId 覆盖——先删旧行与旧 FTS 项再插入）。 */
  upsertDocuments(docs: SearchDocument[]): void {
    if (docs.length === 0) return;
    const selectRowid = this.handle.prepare(
      "SELECT rowid FROM notes WHERE page_id = ?",
    );
    const deleteFts = this.fts
      ? this.handle.prepare("DELETE FROM notes_fts WHERE rowid = ?")
      : null;
    const deleteNote = this.handle.prepare(
      "DELETE FROM notes WHERE page_id = ?",
    );
    const insertNote = this.handle.prepare(
      `INSERT INTO notes (
        page_id, vault_id, stable_note_id, relative_path, title, tags_json,
        body_text, normalized_title, normalized_tags, normalized_body,
        created_at, updated_at, version_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.fts
      ? this.handle.prepare(
          "INSERT INTO notes_fts (rowid, tokens) VALUES (?, ?)",
        )
      : null;
    this.handle.exec("BEGIN");
    try {
      for (const doc of docs) {
        const existing = selectRowid.get(doc.pageId) as
          | { rowid: number }
          | undefined;
        if (existing !== undefined) {
          deleteFts?.run(existing.rowid);
          deleteNote.run(doc.pageId);
        }
        const tagsJoined = doc.tags.join("\n");
        const info = insertNote.run(
          doc.pageId,
          doc.vaultId,
          doc.stableNoteId,
          doc.relativePath,
          doc.title,
          JSON.stringify(doc.tags),
          doc.bodyText,
          normalizeSearchText(doc.title),
          normalizeSearchText(tagsJoined),
          normalizeSearchText(doc.bodyText),
          doc.createdAt,
          doc.updatedAt,
          doc.versionToken,
        );
        if (insertFts) {
          const tokens = tokenizeForSearchIndex(
            `${doc.title}\n${tagsJoined}\n${doc.bodyText}`,
          ).join(" ");
          insertFts.run(Number(info.lastInsertRowid), tokens);
        }
      }
      this.handle.exec("COMMIT");
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  /** 移除单条索引；条目不存在为 no-op。 */
  removeDocument(pageId: string): void {
    const existing = this.handle
      .prepare("SELECT rowid FROM notes WHERE page_id = ?")
      .get(pageId) as { rowid: number } | undefined;
    if (existing === undefined) return;
    this.handle.exec("BEGIN");
    try {
      if (this.fts) {
        this.handle
          .prepare("DELETE FROM notes_fts WHERE rowid = ?")
          .run(existing.rowid);
      }
      this.handle.prepare("DELETE FROM notes WHERE page_id = ?").run(pageId);
      this.handle.exec("COMMIT");
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  /** 清空全部派生内容（rebuild 前置；不删文件本身）。 */
  clearAll(): void {
    this.handle.exec("BEGIN");
    try {
      if (this.fts) this.handle.exec("DELETE FROM notes_fts");
      this.handle.exec("DELETE FROM notes");
      this.handle.exec("COMMIT");
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 候选召回（精排前）：normalizedQuery 必须已经归一化（trim + 小写）。
   * FTS5 bigram AND 召回优先；查询不产生 \p{L}\p{N} token（纯 emoji/
   * 标点）或 FTS 不可用时回退 instr 子串扫描——两种召回都是契约「归一
   * 化子串匹配」语义的超集，交集正确性由契约层精排保证。cap 为召回
   * 上限（安全闸，非结果上限）。
   */
  recall(normalizedQuery: string, cap: number): SearchDocument[] {
    if (normalizedQuery === "" || cap <= 0) return [];
    const tokens = tokenizeForSearchQuery(normalizedQuery);
    if (this.fts && tokens.length > 0) {
      // token 只含 \p{L}\p{N} 字符，双引号包裹即合法 FTS5 字符串；
      // 空格分隔在 FTS5 MATCH 中即隐式 AND。
      const match = tokens.map((token) => `"${token}"`).join(" ");
      const rows = this.handle
        .prepare(
          `SELECT n.* FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ? LIMIT ?`,
        )
        .all(match, cap);
      return rows.map(rowToDocument);
    }
    const rows = this.handle
      .prepare(
        `SELECT * FROM notes
         WHERE instr(normalized_title, ?) > 0
            OR instr(normalized_tags, ?) > 0
            OR instr(normalized_body, ?) > 0
         LIMIT ?`,
      )
      .all(normalizedQuery, normalizedQuery, normalizedQuery, cap);
    return rows.map(rowToDocument);
  }

  /** 库存全部源文档（重建自派生/诊断快照；派生结构可由其完整重建）。 */
  listDocuments(): SearchDocument[] {
    const rows = this.handle.prepare("SELECT * FROM notes").all();
    return rows.map(rowToDocument);
  }

  countDocuments(): number {
    const row = this.handle
      .prepare("SELECT COUNT(*) AS c FROM notes")
      .get() as { c: number };
    return Number(row.c);
  }

  close(): void {
    this.handle.close();
  }
}

function rowToDocument(row: unknown): SearchDocument {
  const r = row as Record<string, unknown>;
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.tags_json));
    if (Array.isArray(parsed)) {
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    // 畸形 tags_json 按空标签集处理（派生数据，重建可修复）。
  }
  return {
    pageId: String(r.page_id),
    vaultId: String(r.vault_id),
    stableNoteId: r.stable_note_id === null ? null : String(r.stable_note_id),
    relativePath: String(r.relative_path),
    title: String(r.title),
    tags,
    bodyText: String(r.body_text),
    createdAt: r.created_at === null ? null : Number(r.created_at),
    updatedAt: r.updated_at === null ? null : Number(r.updated_at),
    versionToken: String(r.version_token),
  };
}
