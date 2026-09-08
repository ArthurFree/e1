/**
 * Desktop 版本历史契约（R012 Stage 0：语义与契约冻结）。
 *
 * 本模块只定义 `.e1/revisions/` 落盘结构的形状（需求文档 §15-16），
 * 不含任何运行时逻辑；shared/ 零依赖、环境中立，Renderer / Main 共用。
 *
 * 核心不变量（详见 docs/architecture/revision-history.md）：
 * - REV-01：revision 是正文历史，不是文件树/元数据历史；
 * - REV-02：Desktop 权威快照是 raw Markdown body（不是 Tiptap JSON /
 *   textSnapshot / SQLite 行）；
 * - REV-04：revision 快照不可重建，不能只存在 SQLite。
 */

/** 快照产生原因；与 domain RevisionReason 同集（shared 不 import src，字面量重复是有意的）。 */
export type DesktopRevisionReason = "interval" | "manual" | "before-restore";

/**
 * Revision series 清单（`.e1/revisions/series/<seriesId>/series.json`）。
 *
 * series 是「同一篇笔记的全部历史快照」的身份容器：
 * - 有 stable id 的文档：stableNoteId 固定 series，rename/move 后历史不变；
 * - path-only 文档：随机 seriesId，currentRelativePath 随 E1 内部
 *   文件操作同步更新；外部移动且无 stable id 时不猜测身份。
 * 历史 snapshot 本身不随文件操作移动，只更新本清单的路径元数据。
 */
export interface RevisionSeriesManifest {
  version: 1;
  seriesId: string;
  /** Frontmatter stable id；path-only 文档为 null。 */
  stableNoteId: string | null;
  /** 当前 Vault 内相对路径（随 rename/move 更新；快照 manifest 记录捕获时路径）。 */
  currentRelativePath: string;
  /** ISO 时间字符串。 */
  createdAt: string;
  updatedAt: string;
}

/**
 * 单个 revision 快照的清单
 * （`.e1/revisions/series/<seriesId>/revisions/<revisionId>/manifest.json`），
 * 与同目录 `body.md`（raw Markdown body，不含 Frontmatter）配套。
 * 快照目录整体不可变：经临时目录写完后 rename 就位（原子创建）。
 */
export interface DesktopRevisionManifest {
  version: 1;
  revisionId: string;
  seriesId: string;
  reason: DesktopRevisionReason;
  /** ISO 时间字符串。 */
  createdAt: string;
  /** 捕获时笔记的 Vault 内相对路径（此后 rename/move 不回改）。 */
  relativePathAtCapture: string;
  /** 捕获时正文来源的版本令牌（如 "sha256:<hash>"），用于审计与诊断。 */
  sourceVersionToken: string;
  /** raw Markdown body 的 SHA-256（hex）；相邻快照同 hash 时 add 去重返回 null。 */
  bodySha256: string;
  /** raw Markdown body 的 UTF-8 字节数（retention 5MiB 预算的计量口径）。 */
  bodyBytes: number;
  /** body 的行尾风格（capture 探测，原样保留、不做归一化）。 */
  lineEnding: "lf" | "crlf";
  /** body 纯文本前若干字符的轻量摘要（列表展示用，见 rawMarkdownBody.ts）。 */
  textPreview: string;
}
