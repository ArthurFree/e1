/**
 * 工作区级 Vault 扫描缓存：同一会话内对同一 vaultId 只扫描一次。
 *
 * 从 repositories.ts 抽出，避免 DesktopMarkdownWriteService ↔ repositories
 * 循环依赖（WriteService 需要扫描路径/assetsDirectory，仓储需要 WriteService）。
 */
import type {
  E1DesktopAPI,
  VaultScanEntry,
  VaultScanResult,
} from "./desktopApi";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { pageIdOfEntry, resolveSessionPageId } from "./vaultMapping";

/** 一次扫描的快照：条目 + 扫描时刻（页面 createdAt/updatedAt 取它）。 */
export interface VaultScanSnapshot {
  result: VaultScanResult;
  scannedAt: number;
}

/**
 * R006-C3（FR-14）：失效/重扫/按页面 id 反查——写路径接通（C4）与
 * 「重新扫描知识库」依赖 invalidate/rescan；findDocument 是正文读取
 * 链路 pageId → vaultId + relativePath 的桥梁。
 */
export class DesktopVaultScanCache {
  private readonly snapshots = new Map<string, Promise<VaultScanSnapshot>>();
  /** Vault 隔离的 pageId → relativePath（FR-13；scan 整体替换，FR-14）。 */
  private readonly pageRelativePathsByVault = new Map<
    string,
    Map<string, string>
  >();
  private readonly assetsDirectoryByVault = new Map<string, string | null>();
  readonly aliases: DesktopIdentityAliasRegistry;

  constructor(
    private readonly api: E1DesktopAPI,
    aliases?: DesktopIdentityAliasRegistry,
  ) {
    this.aliases = aliases ?? new DesktopIdentityAliasRegistry();
  }

  /** 扫描（或取缓存）指定 Vault；并发调用共享同一 Promise。 */
  scan(vaultId: string): Promise<VaultScanSnapshot> {
    let pending = this.snapshots.get(vaultId);
    if (!pending) {
      pending = this.api.vault.scan(vaultId).then((result) => {
        const nextIndex = new Map<string, string>();
        for (const entry of result.entries) {
          if (entry.kind !== "document") continue;
          nextIndex.set(pageIdOfEntry(entry), entry.relativePath);
          const sessionId = resolveSessionPageId(vaultId, entry, this.aliases);
          nextIndex.set(sessionId, entry.relativePath);
          const alias =
            this.aliases.getByRelativePath(vaultId, entry.relativePath) ??
            (entry.noteId
              ? this.aliases.getByStableNoteId(entry.noteId)
              : null);
          if (alias?.vaultId === vaultId) {
            nextIndex.set(alias.sessionPageId, entry.relativePath);
            nextIndex.set(alias.stableNoteId, entry.relativePath);
          }
        }
        this.pageRelativePathsByVault.set(vaultId, nextIndex);
        this.assetsDirectoryByVault.set(
          vaultId,
          result.vault.assetsDirectory ?? null,
        );
        return { result, scannedAt: Date.now() };
      });
      this.snapshots.set(vaultId, pending);
      pending.catch(() => {
        this.snapshots.delete(vaultId);
        this.pageRelativePathsByVault.delete(vaultId);
        this.assetsDirectoryByVault.delete(vaultId);
      });
    }
    return pending;
  }

  /** 使指定 Vault 的缓存失效（FR-15：同时清理路径索引）。 */
  invalidate(vaultId: string): void {
    this.snapshots.delete(vaultId);
    this.pageRelativePathsByVault.delete(vaultId);
    this.assetsDirectoryByVault.delete(vaultId);
  }

  /** 全部缓存失效（如 Vault 列表整体刷新）。不清理 Alias（FR-11）。 */
  invalidateAll(): void {
    this.snapshots.clear();
    this.pageRelativePathsByVault.clear();
    this.assetsDirectoryByVault.clear();
  }

  /** 强制重新扫描（跳过缓存并以新快照替换；失败时保留语义同 scan）。 */
  rescan(vaultId: string): Promise<VaultScanSnapshot> {
    this.invalidate(vaultId);
    return this.scan(vaultId);
  }

  /**
   * 按页面 id 在已缓存的扫描快照中反查所属 Vault 与条目（FR-14）。
   * 同时识别 Session Alias（Adoption 后仍可用 path:* 打开）。
   */
  async findDocument(
    pageId: string,
  ): Promise<{ vaultId: string; entry: VaultScanEntry } | null> {
    const alias =
      this.aliases.getBySessionPageId(pageId) ??
      this.aliases.getByStableNoteId(pageId);
    for (const [vaultId, pending] of this.snapshots) {
      const snapshot = await pending.catch(() => null);
      if (!snapshot) continue;
      const entry = snapshot.result.entries.find((e) => {
        if (e.kind !== "document") return false;
        if (pageIdOfEntry(e) === pageId) return true;
        if (resolveSessionPageId(vaultId, e, this.aliases) === pageId) {
          return true;
        }
        if (alias && alias.vaultId === vaultId) {
          if (e.relativePath === alias.relativePath) return true;
          if (e.noteId && e.noteId === alias.stableNoteId) return true;
        }
        return false;
      });
      if (entry) return { vaultId, entry };
    }
    return null;
  }

  /** 在已缓存的扫描快照中按页面 id 找条目（listPageTagIds 用）。 */
  async findEntryByPageId(pageId: string): Promise<VaultScanEntry | null> {
    const found = await this.findDocument(pageId);
    return found?.entry ?? null;
  }

  /** 同步取页面相对路径（mention 解析；未扫描到返回 null）。Vault 隔离。 */
  getRelativePathSync(vaultId: string, pageId: string): string | null {
    return this.pageRelativePathsByVault.get(vaultId)?.get(pageId) ?? null;
  }

  getAssetsDirectorySync(vaultId: string): string | null {
    return this.assetsDirectoryByVault.get(vaultId) ?? null;
  }
}
