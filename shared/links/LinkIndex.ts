/**
 * 派生链接索引契约（R010 Stage 3 §6/§11，LINK-03）：Desktop 链接索引的
 * 环境中立 port——Renderer（application/components 经
 * src/application/links/LinkIndex.ts 重导出消费）与 Electron Main
 * （SQLite 实现/契约套件）共用同一来源。
 *
 * 语义冻结（契约套件强制，见 shared/links/linkIndexContract.ts）：
 * - 身份（noteKey）：stableNoteId ?? "path:<relativePath>"——与全文搜索
 *   note_key 同一派生规则（§17 以代码里 search 的身份口径为准）；
 * - 解析：internal 链接的目标路径（vault 根归一）在当前索引快照中解析到
 *   目标 noteKey → targetPageId 落库；解析不到（文件缺失/.. 逃逸）→
 *   broken=true、targetPageId=null；external/mailto/asset/anchor 不参与
 *   broken 裁决（恒 false）；
 * - 恢复是重解析的副产品而非独立状态机：目标 upsert / relocate 到
 *   broken 链接的目标路径 / rebuild 时自动翻回 broken=false；
 * - 源文档 relocate：保持身份只改路径，其出站链接按新位置重新锚定
 *  （相对 href 以新目录为基准重算目标路径）；
 * - upsert/remove 幂等；索引是 derived data（LINK-03）：删除索引库后
 *   可从 Markdown 全量 rebuild，绝不回写 Markdown；
 * - 状态机直接复用 SearchIndexStatus 五态（不另造类型）。
 *
 * 实现：
 * - 内存参照：src/infrastructure/memory/linkIndex.ts（契约基准）；
 * - Desktop：SQLite（Electron Main node:sqlite，与搜索索引共库单连接）
 *   + IPC 适配（src/platform/desktop/DesktopLinkIndex.ts）。
 */
import type { SearchIndexStatus } from "../ipc/contracts.js";
import type { ExtractedLink } from "./extractDocumentLinks.js";
import type { Backlink, DocumentLink } from "./types.js";

/** 索引一篇文档所需的全部字段（Main 索引侧由 Markdown 提取供给）。 */
export interface LinkIndexDocument {
  /** 索引身份：stableNoteId ?? "path:<relativePath>"。 */
  noteKey: string;
  vaultId: string;
  /** Frontmatter 稳定 id；无 id 文档为 null（path 身份）。 */
  stableNoteId: string | null;
  /** 相对 Vault 根的 POSIX 路径（relocate 的更新目标）。 */
  relativePath: string;
  /** 文档标题（Backlink.sourceTitle 来源）。 */
  title: string;
  /** 内容版本令牌（DocumentLink.sourceVersion 来源，增量去重依据）。 */
  versionToken: string;
  /**
   * 双提取器（Markdown/JSON）的原始输出；路径链接的目标解析
   *（targetPageId/broken 裁决）由索引实现按当前快照完成，
   * Editor 节点引用（internalLink/mention）经 knownTargetPageId 直接解析。
   */
  links: ExtractedLink[];
}

export interface LinkIndex {
  /**
   * 确保索引可用：状态 missing 时触发重建（building → ready）；
   * 已 ready 为 no-op。会话打开 Vault / 外部事件到达时的自动入口。
   */
  prepare(vaultId: string): Promise<void>;

  /**
   * 删除并重建指定 Vault 的链接索引。documents 由调用方从真实数据源
   *（Markdown）供给；实现侧自读的实现（Main 批量索引）可忽略该参数。
   * 幂等；完成后 getStatus(vaultId).state === "ready"。
   */
  rebuild(
    vaultId: string,
    documents?: Iterable<LinkIndexDocument> | AsyncIterable<LinkIndexDocument>,
  ): Promise<void>;

  /**
   * 单文档 upsert（created/modified/self-write 提交）：Main 自读盘解析
   *（DSK-02 同口径，Renderer 只传 vaultId + relativePath）；文件已消失
   *（与 deleted 竞态）返回 indexed=false，调用方按 remove 收口。
   */
  upsert(input: {
    vaultId: string;
    relativePath: string;
  }): Promise<{ indexed: boolean }>;

  /** 删除单篇文档的索引（deleted）；对缺失条目为 no-op（幂等）。 */
  remove(input: {
    vaultId: string;
    noteKey?: string;
    relativePath?: string;
  }): Promise<void>;

  /**
   * 移动/重命名文件（moved）：保持页面身份只改路径；path 身份文档的
   * noteKey 随路径改写，指向它的链接同步更新；源文档自身出站链接按
   * 新位置重新锚定。目标文档不存在时为 no-op。
   */
  relocate(input: {
    vaultId: string;
    noteKey?: string;
    fromRelativePath: string;
    toRelativePath: string;
  }): Promise<void>;

  /** 单篇文档的出站链接（文档顺序）；未索引返回 []。 */
  getOutgoing(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<DocumentLink[]>;

  /** 谁引用了目标页面（按 sourcePageId 稳定排序）；未索引返回 []。 */
  getBacklinks(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<Backlink[]>;

  /** 当前快照中全部 broken 链接（目标不可解析的 internal 链接）。 */
  getBrokenLinks(vaultId: string): Promise<DocumentLink[]>;

  /** 索引状态（同步快照；IPC 实现为 Renderer 侧镜像）。 */
  getStatus(vaultId: string): SearchIndexStatus;
}
