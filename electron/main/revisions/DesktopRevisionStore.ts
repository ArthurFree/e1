/**
 * R012 Stage 1（需求 §15-19、§32）：Desktop 版本历史不可变快照存储。
 *
 * 存储结构（<Vault>/.e1/revisions/）：
 *   series/<seriesId>/series.json                    —— 身份清单（Identity 模块负责）
 *   series/<seriesId>/revisions/<revisionId>/
 *     ├── manifest.json                              —— DesktopRevisionManifest
 *     └── body.md                                    —— raw Markdown body（逐字节原样）
 *
 * 关键语义：
 * - REV-02：权威快照是 raw Markdown body——capture 经 NoteFileSystem 读当前
 *   Markdown，splitRawMarkdownBody 切出 body 原串子串落盘（不做行尾归一化；
 *   BOM 只可能出现在 Frontmatter 区域，body 天然无 BOM）；
 * - 原子创建（§18）：先写 `<revisionId>.tmp-<random>/` 临时目录，
 *   manifest + body 全部写完后 rename 就位；中断残留的临时目录在
 *   构造后首次使用时清理；
 * - 去重（§19）：当前 body 的 SHA-256 与 series 最新快照的 bodySha256
 *   相同则返回 null（不落盘）；调用方已知当前 body hash 时可传
 *   expectedBodySha256 短路，避免重读文件；
 * - 降级（§32）：list 时单条 corrupt / unknown-version manifest 只进
 *   degraded 列表跳过该条，不拖垮整体。
 *
 * 路径安全：所有路径段只有固定字面量（.e1/revisions/series/...）与经
 * assertSafeRevisionId 正则校验的 id（无分隔符/点，天然不可逃逸），
 * vaultRoot 经 realpath 解析——与 PathGuard 同口径。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  extractRevisionTextPreview,
  splitRawMarkdownBody,
} from "../../../shared/revisions/rawMarkdownBody.js";
import type {
  DesktopRevisionManifest,
  DesktopRevisionReason,
} from "../../../shared/revisions/types.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";

/* ------------------------------------------------------------------ */
/* id 生成与校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * Crockford base32（ULID 字母表）。revisionId 用单调 ULID：同毫秒并发的
 * 多次 capture 也能保证 id 次序与时间次序一致（list 排序的确定性 tiebreak）。
 */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function incrementRandom(random: number[]): number[] {
  const next = [...random];
  for (let i = ULID_RANDOM_LENGTH - 1; i >= 0; i -= 1) {
    if (next[i]! < 31) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  return next; // 80 bit 全段进位（实际不可能）：回绕
}

/**
 * 生成单调 ULID（26 字符大写）。时钟回拨时沿用上一时间戳；
 * 同毫秒内随机段递增。electron 不得 import src/infrastructure/id.ts
 * （electron-no-src），故本地实现。
 */
export function createRevisionId(now: number = Date.now()): string {
  const time = now <= lastTime ? lastTime : now;
  const random =
    time === lastTime
      ? incrementRandom(lastRandom)
      : Array.from(randomBytes(ULID_RANDOM_LENGTH), (b) => b % 32);
  lastTime = time;
  lastRandom = random;

  let timePart = "";
  let value = time;
  for (let i = 0; i < ULID_TIME_LENGTH; i += 1) {
    timePart = ULID_ALPHABET[value % 32] + timePart;
    value = Math.floor(value / 32);
  }
  const randomPart = random.map((v) => ULID_ALPHABET[v]).join("");
  return timePart + randomPart;
}

/**
 * seriesId / revisionId 的合法形态：字母数字 + `_`/`-`（含 `sn_`/`sp_` 前缀
 * 与 ULID）。拒绝一切分隔符与点——id 只由本模块/Identity 生成，外来形态
 * 一律视为调用方错误（与 VaultTrashFileSystem 的 operationId 校验同模式）。
 */
const REVISION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function assertSafeRevisionId(id: string): void {
  if (!REVISION_ID_PATTERN.test(id)) {
    throw new IpcFailure("INVALID_INPUT", `非法的 revision 标识：${id}`);
  }
}

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

/** `.e1/revisions/series/` 绝对路径（vaultRoot 经 realpath 解析）。 */
export async function resolveRevisionSeriesRoot(
  vaultRoot: string,
): Promise<string> {
  const rootReal = await realpath(vaultRoot);
  return join(rootReal, ".e1", "revisions", "series");
}

/** series 目录：`<seriesRoot>/<seriesId>`。 */
export function seriesDirPath(seriesRoot: string, seriesId: string): string {
  assertSafeRevisionId(seriesId);
  return join(seriesRoot, seriesId);
}

/** 单个 series 的快照目录：`<seriesDir>/revisions`。 */
export function seriesRevisionsDirPath(seriesDir: string): string {
  return join(seriesDir, "revisions");
}

/** 临时目录名后缀（启动清理与 list 跳过的识别依据）。 */
const TEMP_DIR_MARKER = ".tmp-";

/* ------------------------------------------------------------------ */
/* manifest 校验                                                       */
/* ------------------------------------------------------------------ */

const REVISION_REASONS: ReadonlySet<string> = new Set([
  "interval",
  "manual",
  "before-restore",
]);

function isDesktopRevisionManifest(
  value: unknown,
): value is DesktopRevisionManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.revisionId === "string" &&
    typeof v.seriesId === "string" &&
    typeof v.reason === "string" &&
    REVISION_REASONS.has(v.reason) &&
    typeof v.createdAt === "string" &&
    typeof v.relativePathAtCapture === "string" &&
    typeof v.sourceVersionToken === "string" &&
    typeof v.bodySha256 === "string" &&
    typeof v.bodyBytes === "number" &&
    (v.lineEnding === "lf" || v.lineEnding === "crlf") &&
    typeof v.textPreview === "string"
  );
}

/**
 * 读单个 revision 的 manifest.json；返回分类结果（missing/corrupt/unknown
 * version 都不抛出——由调用方决定降级语义）。
 */
type ManifestReadResult =
  | { kind: "ok"; manifest: DesktopRevisionManifest }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string };

async function readRevisionManifest(
  revisionDir: string,
): Promise<ManifestReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(revisionDir, "manifest.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "corrupt", reason: `manifest 读取失败（${code ?? "IO"}）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "manifest 不是合法 JSON" };
  }
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (version !== 1) {
    return {
      kind: "corrupt",
      reason: `不支持的 manifest 版本：${String(version)}`,
    };
  }
  if (!isDesktopRevisionManifest(parsed)) {
    return { kind: "corrupt", reason: "manifest 结构不符合 v1" };
  }
  return { kind: "ok", manifest: parsed };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface CaptureRevisionInput {
  /** 目标 series（由 DesktopRevisionIdentity.resolveSeries 解析）。 */
  seriesId: string;
  /** 当前笔记的 Vault 内相对路径（读当前 Markdown + 记入 manifest）。 */
  relativePath: string;
  reason: DesktopRevisionReason;
  /** 触发本次捕获的保存版本令牌（审计/诊断用，原样记入 manifest）。 */
  sourceVersionToken: string;
  /**
   * 可选乐观锁（§21 expectedVersion revalidate）：携带时复核磁盘当前
   * versionToken，不一致抛 DOCUMENT_CONFLICT——不捕获外部改写后的状态。
   */
  expectedVersionToken?: string;
  /**
   * 调用方已知的当前 body SHA-256（hex）。与 series 最新快照一致时
   * 直接短路返回 null，跳过文件重读。
   */
  expectedBodySha256?: string;
}

export interface RevisionListResult {
  /** 有效快照 manifest，createdAt 倒序（最新在前；并列时 revisionId 倒序）。 */
  revisions: DesktopRevisionManifest[];
  /** 损坏/未知版本的条目（只降级该条，不影响其余）。 */
  degraded: { revisionId: string; reason: string }[];
}

export type RevisionReadResult =
  | { kind: "ok"; manifest: DesktopRevisionManifest; body: string }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string };

export class DesktopRevisionStore {
  /** 启动清理只跑一次（构造后首次使用时）。 */
  private cleanupOnce: Promise<void> | null = null;

  constructor(private readonly vaultRoot: string) {}

  private ensureCleanedUp(): Promise<void> {
    this.cleanupOnce ??= this.cleanStaleTempDirs();
    return this.cleanupOnce;
  }

  /** 清理所有 series 下中断残留的 `<revisionId>.tmp-*` 临时目录（§18）。 */
  private async cleanStaleTempDirs(): Promise<void> {
    let seriesRoot: string;
    try {
      seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    } catch {
      return; // vaultRoot 不可达：无可清理
    }
    let seriesDirs;
    try {
      seriesDirs = await readdir(seriesRoot, { withFileTypes: true });
    } catch {
      return; // 尚无 revisions 存储
    }
    for (const series of seriesDirs) {
      if (!series.isDirectory()) continue;
      const revisionsDir = seriesRevisionsDirPath(
        join(seriesRoot, series.name),
      );
      let entries;
      try {
        entries = await readdir(revisionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.includes(TEMP_DIR_MARKER)) continue;
        await rm(join(revisionsDir, entry.name), {
          recursive: true,
          force: true,
        }).catch(() => {
          // 清理失败不影响主流程
        });
      }
    }
  }

  /**
   * 捕获当前 Markdown 的 raw body 快照。
   * @returns 新 manifest；与最新快照 body 相同（去重）时返回 null。
   * @throws IpcFailure NOTE_NOT_FOUND / NOTE_* （NoteFileSystem 读取失败）
   */
  async capture(
    input: CaptureRevisionInput,
  ): Promise<DesktopRevisionManifest | null> {
    await this.ensureCleanedUp();
    assertSafeRevisionId(input.seriesId);
    const seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    const revisionsDir = seriesRevisionsDirPath(
      seriesDirPath(seriesRoot, input.seriesId),
    );

    const { revisions } = await this.list(input.seriesId);
    const latest = revisions[0];
    // 调用方短路：已知当前 body hash 与最新快照一致 → 不落盘。
    if (
      input.expectedBodySha256 !== undefined &&
      latest?.bodySha256 === input.expectedBodySha256
    ) {
      return null;
    }

    // 重读当前 Markdown（权威来源是磁盘文件，不是调用方内存态）。
    const note = await readNoteFile({
      vaultRoot: this.vaultRoot,
      relativePath: input.relativePath,
    });
    // §21：可选乐观锁复核——磁盘版本与调用方预期不一致时不捕获。
    if (
      input.expectedVersionToken !== undefined &&
      note.versionToken !== input.expectedVersionToken
    ) {
      throw new IpcFailure(
        "DOCUMENT_CONFLICT",
        "笔记内容已被修改，版本快照未创建。",
      );
    }
    const { body, lineEnding } = splitRawMarkdownBody(note.markdown);
    const bodyBytes = Buffer.from(body, "utf8");
    const bodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
    if (latest?.bodySha256 === bodySha256) return null;

    const revisionId = createRevisionId();
    const manifest: DesktopRevisionManifest = {
      version: 1,
      revisionId,
      seriesId: input.seriesId,
      reason: input.reason,
      createdAt: new Date().toISOString(),
      relativePathAtCapture: input.relativePath,
      sourceVersionToken: input.sourceVersionToken,
      bodySha256,
      bodyBytes: bodyBytes.byteLength,
      lineEnding,
      textPreview: extractRevisionTextPreview(body),
    };

    // 原子创建（§18）：临时目录写齐 manifest + body 后 rename 就位。
    const finalDir = join(revisionsDir, revisionId);
    const tempDir = join(
      revisionsDir,
      `${revisionId}${TEMP_DIR_MARKER}${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tempDir, { recursive: true });
    try {
      // body 逐字节原样：不动行尾、不加 BOM。
      await writeFile(join(tempDir, "body.md"), bodyBytes);
      await writeFile(
        join(tempDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        // 清理失败不影响主错误
      });
      throw error;
    }
    return manifest;
  }

  /** 列出 series 全部有效快照（createdAt 倒序）+ 降级条目。 */
  async list(seriesId: string): Promise<RevisionListResult> {
    await this.ensureCleanedUp();
    const seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    const revisionsDir = seriesRevisionsDirPath(
      seriesDirPath(seriesRoot, seriesId),
    );
    const result: RevisionListResult = { revisions: [], degraded: [] };

    let entries;
    try {
      entries = await readdir(revisionsDir, { withFileTypes: true });
    } catch {
      return result; // series 尚无快照目录
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.includes(TEMP_DIR_MARKER)) {
        continue;
      }
      const read = await readRevisionManifest(join(revisionsDir, entry.name));
      if (read.kind === "ok") {
        result.revisions.push(read.manifest);
      } else if (read.kind === "corrupt") {
        result.degraded.push({ revisionId: entry.name, reason: read.reason });
      }
      // missing：目录存在但 manifest 缺失（半截状态）——同样降级报告。
      else {
        result.degraded.push({
          revisionId: entry.name,
          reason: "manifest.json 缺失",
        });
      }
    }
    result.revisions.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.revisionId.localeCompare(a.revisionId),
    );
    return result;
  }

  /** 按 revisionId 读 manifest + body.md。 */
  async get(seriesId: string, revisionId: string): Promise<RevisionReadResult> {
    await this.ensureCleanedUp();
    assertSafeRevisionId(revisionId);
    const seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    const revisionDir = join(
      seriesRevisionsDirPath(seriesDirPath(seriesRoot, seriesId)),
      revisionId,
    );

    const read = await readRevisionManifest(revisionDir);
    if (read.kind === "missing") return { kind: "missing" };
    if (read.kind === "corrupt") {
      return { kind: "corrupt", reason: read.reason };
    }
    let body: string;
    try {
      body = await readFile(join(revisionDir, "body.md"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return {
        kind: "corrupt",
        reason: `body.md 读取失败（${code ?? "IO"}）`,
      };
    }
    return { kind: "ok", manifest: read.manifest, body };
  }

  /** 物理删除单个快照目录（retention 用；删除即不可恢复）。 */
  async removeRevision(seriesId: string, revisionId: string): Promise<void> {
    assertSafeRevisionId(revisionId);
    const seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    await rm(
      join(
        seriesRevisionsDirPath(seriesDirPath(seriesRoot, seriesId)),
        revisionId,
      ),
      { recursive: true, force: true },
    );
  }

  /**
   * R012 Stage 2：物理删除整个 series 目录（文档 purge 的历史清理，
   * revision.purgeSeries 通道；删除即不可恢复）。
   * @returns 是否命中并删除了某个 series。
   */
  async purgeSeries(seriesId: string): Promise<boolean> {
    assertSafeRevisionId(seriesId);
    const seriesRoot = await resolveRevisionSeriesRoot(this.vaultRoot);
    try {
      await rm(seriesDirPath(seriesRoot, seriesId), { recursive: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
