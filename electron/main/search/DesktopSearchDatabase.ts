/**
 * R008 Stage 4（§11，R8-03/04）：Desktop 全文搜索 SQLite 库——
 * node:sqlite（Electron 内置 Node 24，FTS5 已验证可用）落
 * userData/search-index/<vaultId>.sqlite。
 *
 * 语义与内存参照实现逐点一致（同一 shared/search/textMatch 评分器，
 * 契约套件 src/test/fullTextSearchContract.ts 双实现强制）：
 * - 中文：应用层 CJK unigram+bigram 词元写 notes_fts（§11.4 方案 B，
 *   不引 SQLite extension）；非词字符 unigram（emoji 等）编码为
 *   "u<码点 hex>" 词元保证 FTS 可检索；
 * - 候选生成：title/tags 归一化 LIKE 子串 + body FTS5 MATCH
 *   （CJK bigram AND / 拉丁词前缀）；
 * - 评分/排序/snippet：scoreDocument/compareSearchResults 全量复用。
 *
 * 派生数据原则：本库只是索引，损坏/版本不兼容一律备份重建，
 * 绝不做复杂迁移、绝不回写 Markdown（R8-03）。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SearchIndexStatus,
  SearchMatchField,
} from "../../../shared/ipc/contracts.js";
import {
  compareSearchResults,
  normalizeSearchText,
  scoreDocument,
  splitQueryTerms,
  tokenizeForIndex,
} from "../../../shared/search/textMatch.js";

/** schema / 索引格式版本（不兼容即整库重建，§13.2）。 */
const SCHEMA_VERSION = "1";
const INDEX_FORMAT_VERSION = "1";
/** 单事务批量 upsert 的文档数（§11.6，100–500 区间）。 */
const BATCH_SIZE = 200;
/** 单查询候选行上限（评分在应用层完成，候选需有界）。 */
const CANDIDATE_LIMIT = 500;

const DDL = `
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  note_key TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  stable_note_id TEXT,
  relative_path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  body_text TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  tags_norm TEXT NOT NULL,
  version_token TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS notes_vault_path ON notes(vault_id, relative_path);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_key UNINDEXED,
  body_tokens
);
`;

/** 索引一条文档（DB 层输入；与 application SearchDocument 同构，Main 不依赖 src）。 */
export interface SearchDocumentRow {
  pageId: string;
  vaultId: string;
  stableNoteId: string | null;
  relativePath: string;
  title: string;
  tags: string[];
  bodyText: string;
  createdAt: number | null;
  updatedAt: number | null;
  versionToken: string;
}

export interface SearchQueryRowOut {
  pageId: string;
  title: string;
  matchedField: SearchMatchField;
  snippet: string | null;
  score: number;
  relativePath: string;
  stableNoteId: string | null;
}

/** 非词字符 unigram（emoji 等）的 FTS 安全编码（unicode61 不会为其建词）。 */
function ftsEncodeToken(token: string): string {
  if (/^[a-z0-9_+\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff-]+$/u.test(token)) return token;
  return `u${[...token].map((ch) => ch.codePointAt(0)!.toString(16)).join("_")}`;
}

/** body 文本 → FTS 词元流（空格连接）。 */
export function ftsTokenStream(bodyText: string): string {
  return [...tokenizeForIndex(bodyText)].map(ftsEncodeToken).join(" ");
}

/** 查询 → FTS5 MATCH 表达式（CJK bigram AND / 拉丁词前缀）；空查询返回 null。 */
export function buildFtsMatchQuery(query: string): string | null {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return null;
  const parts: string[] = [];
  for (const term of terms) {
    if (/^[a-z0-9_+-]+$/.test(term)) {
      // 纯拉丁词：前缀匹配（字符集经归一化必然安全，无需引号）。
      parts.push(`${term}*`);
      continue;
    }
    // CJK / emoji 等：与索引同规则词元化并编码，要求全部命中（AND）。
    for (const token of tokenizeForIndex(term)) {
      parts.push(`"${ftsEncodeToken(token).replace(/"/g, '""')}"`);
    }
  }
  return parts.join(" AND ");
}

/** LIKE 子串转义（% _ \）。 */
function likePattern(normalized: string): string {
  return `%${normalized.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

interface NoteRow {
  note_key: string;
  vault_id: string;
  stable_note_id: string | null;
  relative_path: string;
  title: string;
  tags_json: string;
  body_text: string;
  title_norm: string;
  tags_norm: string;
  version_token: string;
  created_at: number | null;
  updated_at: number | null;
}

export class DesktopSearchDatabase {
  private db: DatabaseSync | null = null;
  private status: SearchIndexStatus = { state: "missing" };

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 打开（必要时创建）数据库；损坏/版本不兼容 → 备份后重建（R8-03）。 */
  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.db = new DatabaseSync(this.filePath);
      this.db.exec(DDL);
      this.assertFormatVersion();
      const count = (
        this.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as {
          c: number;
        }
      ).c;
      this.status = { state: "ready", indexedDocuments: count };
    } catch (error) {
      // 损坏/版本不兼容：关闭 → 备份 .corrupt-<ts> → 重建空库（§13.3）。
      await this.recoverCorrupt(error);
      this.db = new DatabaseSync(this.filePath);
      this.db.exec(DDL);
      this.writeFormatVersion();
      this.status = { state: "missing" };
    }
    return this.db;
  }

  private assertFormatVersion(): void {
    const meta = this.db!;
    const read = (key: string) =>
      (
        meta.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
          { value: string } | undefined
      )?.value;
    if (read("schema_version") === undefined) {
      // 全新库：写入版本标记。
      this.writeFormatVersion();
      return;
    }
    if (
      read("schema_version") !== SCHEMA_VERSION ||
      read("index_format_version") !== INDEX_FORMAT_VERSION
    ) {
      throw new Error("索引格式版本不兼容");
    }
  }

  private writeFormatVersion(): void {
    const meta = this.db!;
    const upsert = meta.prepare(
      "INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)",
    );
    upsert.run("schema_version", SCHEMA_VERSION);
    upsert.run("index_format_version", INDEX_FORMAT_VERSION);
  }

  private async recoverCorrupt(reason: unknown): Promise<void> {
    try {
      this.db?.close();
    } catch {
      // 忽略关闭失败。
    }
    this.db = null;
    const backup = `${this.filePath}.corrupt-${this.now()}`;
    await copyFile(this.filePath, backup).catch(() => undefined);
    await rm(this.filePath, { force: true }).catch(() => undefined);
    console.warn(
      `搜索索引库损坏或版本不兼容，已备份重建：${(reason as Error)?.message ?? reason}`,
    );
  }

  getStatus(vaultId: string): SearchIndexStatus {
    // DB 文件已按 vault 隔离，参数仅作调用方语义对齐（与 port 形状一致）。
    void vaultId;
    return this.status;
  }

  /** 全量重建：清空整库 + 分批事务 upsert（§11.5/§11.6）。 */
  async rebuild(
    documents: Iterable<SearchDocumentRow> | AsyncIterable<SearchDocumentRow>,
  ): Promise<void> {
    const db = await this.open();
    this.status = { state: "building" };
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM notes");
      db.exec("DELETE FROM notes_fts");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
    let count = 0;
    let batch: SearchDocumentRow[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      this.upsertBatch(db, batch);
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
    this.status = { state: "ready", indexedDocuments: count };
  }

  private upsertBatch(db: DatabaseSync, batch: SearchDocumentRow[]): void {
    const upsertNote = db.prepare(
      `INSERT OR REPLACE INTO notes(
        note_key, vault_id, stable_note_id, relative_path, title, tags_json,
        body_text, title_norm, tags_norm, version_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertFts = db.prepare(
      "INSERT OR REPLACE INTO notes_fts(note_key, body_tokens) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const document of batch) {
        this.runUpsert(upsertNote, upsertFts, document);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      this.status = { state: "degraded", reason: String(error) };
      throw error;
    }
  }

  private runUpsert(
    upsertNote: StatementSync,
    upsertFts: StatementSync,
    document: SearchDocumentRow,
  ): void {
    upsertNote.run(
      document.pageId,
      document.vaultId,
      document.stableNoteId,
      document.relativePath,
      document.title,
      JSON.stringify(document.tags),
      document.bodyText,
      normalizeSearchText(document.title),
      document.tags.map(normalizeSearchText).join(" "),
      document.versionToken,
      document.createdAt,
      document.updatedAt,
    );
    upsertFts.run(document.pageId, ftsTokenStream(document.bodyText));
  }

  /** 单文档 upsert（幂等）；versionToken 未变的重复提交跳过写入（§12.3）。 */
  async upsert(document: SearchDocumentRow): Promise<void> {
    const db = await this.open();
    const existing = db
      .prepare(
        "SELECT version_token, relative_path FROM notes WHERE note_key = ?",
      )
      .get(document.pageId) as
      { version_token: string; relative_path: string } | undefined;
    if (
      existing &&
      existing.version_token === document.versionToken &&
      existing.relative_path === document.relativePath
    ) {
      return;
    }
    this.upsertBatch(db, [document]);
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }
    ).c;
    this.status = { state: "ready", indexedDocuments: count };
  }

  /** 按 note_key 删除（幂等）。 */
  async remove(noteKey: string): Promise<void> {
    const db = await this.open();
    db.prepare("DELETE FROM notes WHERE note_key = ?").run(noteKey);
    db.prepare("DELETE FROM notes_fts WHERE note_key = ?").run(noteKey);
  }

  /** 按相对路径删除（文件已消失的场景；幂等）。 */
  async removeByPath(vaultId: string, relativePath: string): Promise<void> {
    const db = await this.open();
    const row = db
      .prepare(
        "SELECT note_key FROM notes WHERE vault_id = ? AND relative_path = ?",
      )
      .get(vaultId, relativePath) as { note_key: string } | undefined;
    if (row) await this.remove(row.note_key);
  }

  /** 移动/重命名：保持身份只改路径（note_key 不变）。 */
  async relocate(noteKey: string, relativePath: string): Promise<void> {
    const db = await this.open();
    db.prepare("UPDATE notes SET relative_path = ? WHERE note_key = ?").run(
      relativePath,
      noteKey,
    );
  }

  /** 按路径移动（IPC 通道；找不到时 no-op 交由调用方 upsert）。 */
  async relocateByPath(
    vaultId: string,
    from: string,
    to: string,
  ): Promise<void> {
    const db = await this.open();
    db.prepare(
      "UPDATE notes SET relative_path = ? WHERE vault_id = ? AND relative_path = ?",
    ).run(to, vaultId, from);
  }

  /** 查询：候选（title/tag LIKE + body FTS）→ 应用层评分 → 稳定排序。 */
  async search(input: {
    vaultId?: string;
    query: string;
    limit?: number;
  }): Promise<SearchQueryRowOut[]> {
    const normalized = normalizeSearchText(input.query.trim());
    if (normalized === "") return [];
    const db = await this.open();
    const limit = Math.min(input.limit ?? 50, 100);
    const matchQuery = buildFtsMatchQuery(normalized);
    const pattern = likePattern(normalized);

    const candidates = new Map<string, NoteRow>();
    const collect = (rows: NoteRow[]) => {
      for (const row of rows) {
        if (candidates.size >= CANDIDATE_LIMIT) return;
        candidates.set(row.note_key, row);
      }
    };
    const titleTagSql = input.vaultId
      ? `SELECT * FROM notes WHERE vault_id = ? AND (
          title_norm LIKE ? ESCAPE '\\' OR tags_norm LIKE ? ESCAPE '\\'
        ) LIMIT ${CANDIDATE_LIMIT}`
      : `SELECT * FROM notes WHERE
          title_norm LIKE ? ESCAPE '\\' OR tags_norm LIKE ? ESCAPE '\\'
        LIMIT ${CANDIDATE_LIMIT}`;
    collect(
      (input.vaultId
        ? db.prepare(titleTagSql).all(input.vaultId, pattern, pattern)
        : db
            .prepare(titleTagSql)
            .all(pattern, pattern)) as unknown as NoteRow[],
    );
    if (matchQuery) {
      const ftsSql = input.vaultId
        ? `SELECT n.* FROM notes n JOIN notes_fts f ON n.note_key = f.note_key
           WHERE n.vault_id = ? AND notes_fts MATCH ? LIMIT ${CANDIDATE_LIMIT}`
        : `SELECT n.* FROM notes n JOIN notes_fts f ON n.note_key = f.note_key
           WHERE notes_fts MATCH ? LIMIT ${CANDIDATE_LIMIT}`;
      try {
        collect(
          (input.vaultId
            ? db.prepare(ftsSql).all(input.vaultId, matchQuery)
            : db.prepare(ftsSql).all(matchQuery)) as unknown as NoteRow[],
        );
      } catch (error) {
        // MATCH 表达式异常（异常字符）按无 body 候选处理，不影响 title/tag。
        console.warn("搜索 FTS 查询失败，已降级为 title/tag 候选：", error);
      }
    }

    const results: SearchQueryRowOut[] = [];
    for (const row of candidates.values()) {
      const scored = scoreDocument(
        {
          title: row.title,
          titleNormalized: row.title_norm,
          tagsNormalized: row.tags_norm === "" ? [] : row.tags_norm.split(" "),
          bodyTokens: tokenizeForIndex(row.body_text),
          bodyText: row.body_text,
        },
        normalized,
      );
      if (!scored) continue;
      results.push({
        pageId: row.note_key,
        title: row.title,
        matchedField: scored.matchedField,
        snippet: scored.snippet,
        score: scored.score,
        relativePath: row.relative_path,
        stableNoteId: row.stable_note_id,
      });
    }
    results.sort(compareSearchResults);
    return results.slice(0, limit);
  }

  /** 读取单条版本令牌（modified 事件的增量去重，§12.3）。 */
  async versionTokenOf(noteKey: string): Promise<string | null> {
    const db = await this.open();
    const row = db
      .prepare("SELECT version_token FROM notes WHERE note_key = ?")
      .get(noteKey) as { version_token: string } | undefined;
    return row?.version_token ?? null;
  }

  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = null;
    }
  }
}

/** search-index 目录 + vaultId 文件名片段校验（与 VaultStateStore 同口径）。 */
const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function searchIndexFilePath(baseDir: string, vaultId: string): string {
  // transient:<uuid> 等非常规 id：确定性哈希文件名（会话级索引，重启即弃）。
  const stem = SAFE_FILE_STEM.test(vaultId)
    ? vaultId
    : `t-${createHash("sha1").update(vaultId).digest("hex").slice(0, 16)}`;
  return `${baseDir}/${stem}.sqlite`;
}

/** 按 Vault 管理的索引库集合（IPC handler 注入共享）。 */
export class DesktopSearchIndexManager {
  private readonly dbs = new Map<string, DesktopSearchDatabase>();

  constructor(private readonly baseDir: string) {}

  forVault(vaultId: string): DesktopSearchDatabase {
    let db = this.dbs.get(vaultId);
    if (!db) {
      db = new DesktopSearchDatabase(
        searchIndexFilePath(this.baseDir, vaultId),
      );
      this.dbs.set(vaultId, db);
    }
    return db;
  }

  /** 跨库检索（vaultId 缺省）：逐库查询后合并重排（仅覆盖已打开的索引库）。 */
  async searchAll(input: {
    query: string;
    limit?: number;
  }): Promise<SearchQueryRowOut[]> {
    const limit = Math.min(input.limit ?? 50, 100);
    const all: SearchQueryRowOut[] = [];
    for (const db of this.dbs.values()) {
      all.push(...(await db.search({ query: input.query, limit })));
    }
    all.sort(compareSearchResults);
    return all.slice(0, limit);
  }

  closeAll(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}
