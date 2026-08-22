/**
 * R008 Stage 5（§12，R8-05）：搜索索引 reconciler——把外部变更流
 *（DesktopExternalVaultChangeService 的归一化事实）映射为索引动作：
 *
 *   created  → search.upsert（Main 读盘解析）
 *   modified → search.upsert（Main 按 versionToken 去重，相同即 no-op）
 *   moved    → search.relocate（from/to 事件路径，身份保持）
 *   deleted  → search.remove（stable id 走 noteKey，path 身份走 relativePath）
 *
 * 自写通道（§12.4）：E1 自己保存成功（DocumentCommitService →
 * DesktopTitleSearchIndex 钩子）也走 search.upsert——watcher 只管外部
 * 变化，自写抑制（SelfWriteRegistry）不会导致索引漏更新。
 *
 * 失败降级（§12.5/R8-06）：任何索引动作失败 → status=degraded +
 * 调度一次延迟 rebuild（30s 防抖），绝不向上抛错阻断正文保存。
 */
import type { ExternalDocumentChange } from "../../application/services/ExternalVaultChangeService";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import type { DesktopSearchIndex } from "./DesktopSearchIndex";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

/** 降级后的延迟重建间隔（ms）。 */
const DEGRADED_REBUILD_DELAY = 30_000;

export class DesktopSearchIndexReconciler {
  private readonly scheduledRebuilds = new Set<string>();

  constructor(
    private readonly deps: {
      api: E1DesktopAPI;
      scans: DesktopVaultScanCache;
      aliases: DesktopIdentityAliasRegistry;
      fullText: DesktopSearchIndex;
      /** 测试可注入的延迟调度（缺省 setTimeout）。 */
      schedule?: (fn: () => void, delayMs: number) => void;
    },
  ) {}

  /** 外部变更批次 → 索引动作（逐条 best-effort，失败进入降级路径）。 */
  async reconcile(changes: ExternalDocumentChange[]): Promise<void> {
    for (const change of changes) {
      // 任何事件先确保索引存在（首次打开未建库的库）。
      await this.deps.fullText.prepare(change.vaultId).catch(() => undefined);
      try {
        await this.applyChange(change);
      } catch (error) {
        this.degrade(change.vaultId, error);
      }
    }
  }

  /** 自写提交（DocumentCommitService 成功保存/创建/覆盖后）。 */
  async onDocumentCommitted(pageId: string): Promise<void> {
    const found = await this.deps.scans.findEntry(pageId).catch(() => null);
    const relativePath =
      found?.entry.relativePath ??
      (pageId.startsWith("path:") ? pageId.slice("path:".length) : null);
    const vaultId = found?.vaultId ?? null;
    if (!relativePath || !vaultId) return;
    try {
      await this.deps.api.search.upsert({ vaultId, relativePath });
    } catch (error) {
      this.degrade(vaultId, error);
    }
  }

  private async applyChange(change: ExternalDocumentChange): Promise<void> {
    const { api } = this.deps;
    switch (change.type) {
      case "created":
      case "modified": {
        const relativePath = await this.relativePathOf(
          change.vaultId,
          change.pageId,
        );
        if (!relativePath) return;
        await api.search.upsert({
          vaultId: change.vaultId,
          relativePath,
        });
        return;
      }
      case "moved": {
        await api.search.relocate({
          vaultId: change.vaultId,
          from: change.from,
          to: change.to,
        });
        return;
      }
      case "deleted": {
        const noteKey = this.noteKeyOf(change.pageId);
        if (noteKey) {
          await api.search.remove({ vaultId: change.vaultId, noteKey });
        } else {
          await api.search.remove({
            vaultId: change.vaultId,
            relativePath: change.pageId.slice("path:".length),
          });
        }
        return;
      }
    }
  }

  /** 页面 id → 当前相对路径（扫描快照 + path: 前缀回退）。 */
  private async relativePathOf(
    vaultId: string,
    pageId: string,
  ): Promise<string | null> {
    const found = await this.deps.scans.findEntry(pageId);
    if (found && found.vaultId === vaultId) return found.entry.relativePath;
    return pageId.startsWith("path:") ? pageId.slice("path:".length) : null;
  }

  /** deleted 事件的稳定键（Adoption 别名 → stableNoteId；path 身份返回 null）。 */
  private noteKeyOf(pageId: string): string | null {
    const alias =
      this.deps.aliases.getBySessionPageId(pageId) ??
      this.deps.aliases.getByStableNoteId(pageId);
    if (alias) return alias.stableNoteId;
    return pageId.startsWith("path:") ? null : pageId;
  }

  /** §12.5：degraded + 调度一次延迟 rebuild（防抖：同库同时仅一次）。 */
  private degrade(vaultId: string, error: unknown): void {
    this.deps.fullText.markDegraded(vaultId, error);
    if (this.scheduledRebuilds.has(vaultId)) return;
    this.scheduledRebuilds.add(vaultId);
    const schedule = this.deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    schedule(() => {
      this.scheduledRebuilds.delete(vaultId);
      void this.deps.fullText.rebuild(vaultId).catch(() => undefined);
    }, DEGRADED_REBUILD_DELAY);
  }
}
