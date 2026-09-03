/**
 * R010 Stage 3（§6/§11）：Desktop 派生链接索引——
 * LinkIndex port 的 IPC-backed 实现。
 *
 * 索引本体在 Main（node:sqlite，与搜索共库单连接，落
 * userData/search-index/<vaultId>.sqlite）；本类只做：
 * - 调用转发（outgoing/backlinks/broken/rebuild/upsert/remove/relocate/status）；
 * - 身份翻译：查询入参的会话页面 id → Main 稳定键（stableNoteId ??
 *   path:<rel>），结果行的 sourcePageId/targetPageId → 会话页面 id
 *  （Adoption 别名解析，与 DesktopSearchIndex.toSessionPageId 同一口径），
 *   消除「同会话 Stable ID Adoption 后面板查询/跳转落空」（R010 Stage 7）；
 * - 状态镜像：getStatus 同步语义由会话内缓存满足（操作后更新，
 *   外部事件经 refreshStatus 刷新，Stage 4 reconciler 驱动）。
 */
import type {
  Backlink,
  DocumentLink,
  LinkIndex,
  LinkRelocationImpact,
} from "../../application/links/LinkIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export class DesktopLinkIndex implements LinkIndex {
  private readonly statusCache = new Map<string, SearchIndexStatus>();

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async rebuild(vaultId: string): Promise<void> {
    this.statusCache.set(vaultId, { state: "building" });
    try {
      const result = await this.api.links.rebuild({ vaultId });
      this.statusCache.set(vaultId, {
        state: "ready",
        indexedDocuments: result.indexedDocuments,
      });
    } catch (error) {
      this.markDegraded(vaultId, error);
      throw error;
    }
  }

  /** 确保索引可用：刷新状态镜像，missing 即重建（building → ready）。 */
  async prepare(vaultId: string): Promise<void> {
    await this.refreshStatus(vaultId);
    if (this.getStatus(vaultId).state === "missing") {
      await this.rebuild(vaultId);
    }
  }

  /** 增量维护失败 → degraded（正文保存不受影响，§12 同口径）。 */
  markDegraded(vaultId: string, reason: unknown): void {
    this.statusCache.set(vaultId, {
      state: "degraded",
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  }

  async upsert(input: {
    vaultId: string;
    relativePath: string;
  }): Promise<{ indexed: boolean }> {
    const result = await this.api.links.upsert(input);
    // 文件已消失（与 deleted 竞态）：按删除收口（不抛错）。
    if (!result.indexed) {
      await this.api.links.remove({
        vaultId: input.vaultId,
        relativePath: input.relativePath,
      });
    }
    return result;
  }

  async remove(input: {
    vaultId: string;
    noteKey?: string;
    relativePath?: string;
  }): Promise<void> {
    await this.api.links.remove({
      ...input,
      noteKey: input.noteKey
        ? this.toNoteKey(input.vaultId, input.noteKey)
        : undefined,
    });
  }

  async relocate(input: {
    vaultId: string;
    noteKey?: string;
    fromRelativePath: string;
    toRelativePath: string;
  }): Promise<void> {
    await this.api.links.relocate({
      ...input,
      noteKey: input.noteKey
        ? this.toNoteKey(input.vaultId, input.noteKey)
        : undefined,
    });
  }

  async getOutgoing(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<DocumentLink[]> {
    const rows = await this.api.links.outgoing({
      vaultId: input.vaultId,
      noteKey: this.toNoteKey(input.vaultId, input.noteKey),
    });
    return rows.map((row) => this.toSessionLink(input.vaultId, row));
  }

  async getBacklinks(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<Backlink[]> {
    const rows = await this.api.links.backlinks({
      vaultId: input.vaultId,
      noteKey: this.toNoteKey(input.vaultId, input.noteKey),
    });
    return rows.map((row) => ({
      ...row,
      sourcePageId: this.toSessionPageId(input.vaultId, row.sourcePageId),
      targetPageId: this.toSessionPageId(input.vaultId, row.targetPageId),
    }));
  }

  async getBrokenLinks(vaultId: string): Promise<DocumentLink[]> {
    const rows = await this.api.links.broken({ vaultId });
    return rows.map((row) => this.toSessionLink(vaultId, row));
  }

  async analyzeRelocation(input: {
    vaultId: string;
    pathMoves: Array<{
      noteKey: string;
      fromRelativePath: string;
      toRelativePath: string;
    }>;
  }): Promise<LinkRelocationImpact[]> {
    const rows = await this.api.links.analyzeRelocation({
      vaultId: input.vaultId,
      pathMoves: input.pathMoves.map((move) => ({
        ...move,
        noteKey: this.toNoteKey(input.vaultId, move.noteKey),
      })),
    });
    return rows.map((row) => ({
      ...row,
      sourcePageId: this.toSessionPageId(input.vaultId, row.sourcePageId),
      targetPageId:
        row.targetPageId === null
          ? null
          : this.toSessionPageId(input.vaultId, row.targetPageId),
    }));
  }

  /** 会话页面 id → Main 稳定键（Adoption 别名；无别名时原样透传）。 */
  private toNoteKey(vaultId: string, pageId: string): string {
    const alias = this.scans.aliases.getBySessionPageId(pageId);
    return alias?.vaultId === vaultId ? alias.stableNoteId : pageId;
  }

  /** Main 稳定键 → 会话页面 id（Adoption 别名；无别名时原样返回）。 */
  private toSessionPageId(vaultId: string, key: string): string {
    const alias = key.startsWith("path:")
      ? this.scans.aliases.getByRelativePath(vaultId, key.slice("path:".length))
      : this.scans.aliases.getByStableNoteId(key);
    return alias?.vaultId === vaultId ? alias.sessionPageId : key;
  }

  /** DocumentLink 行的身份翻译（source/target 两端）。 */
  private toSessionLink(vaultId: string, row: DocumentLink): DocumentLink {
    return {
      ...row,
      sourcePageId: this.toSessionPageId(vaultId, row.sourcePageId),
      targetPageId:
        row.targetPageId === null
          ? null
          : this.toSessionPageId(vaultId, row.targetPageId),
    };
  }

  getStatus(vaultId: string): SearchIndexStatus {
    return this.statusCache.get(vaultId) ?? { state: "missing" };
  }

  /** 刷新状态镜像（Stage 4：外部变更 reconciliation / 会话加载后）。 */
  async refreshStatus(vaultId: string): Promise<void> {
    this.statusCache.set(vaultId, await this.api.links.status({ vaultId }));
  }
}
