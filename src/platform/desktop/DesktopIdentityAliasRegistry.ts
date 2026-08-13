/**
 * R006-C4.1-B（FR-07~12）：Session 内 Stable ID ↔ 页面身份别名。
 *
 * Adoption 后磁盘写入 Frontmatter id，但当前 Session 的 Page.id 仍保持
 * path:*，避免重新扫描导致编辑器/页面树身份分叉。仅内存、不持久化。
 * 重新扫描不得清理；关闭 Vault / 进程退出后自然消失。
 */
export interface DesktopIdentityAlias {
  vaultId: string;
  sessionPageId: string;
  stableNoteId: string;
  relativePath: string;
}

export class DesktopIdentityAliasRegistry {
  private readonly bySessionPageId = new Map<string, DesktopIdentityAlias>();
  private readonly byStableNoteId = new Map<string, DesktopIdentityAlias>();
  private readonly byVaultPath = new Map<string, DesktopIdentityAlias>();

  register(alias: DesktopIdentityAlias): void {
    this.bySessionPageId.set(alias.sessionPageId, alias);
    this.byStableNoteId.set(this.stableKey(alias.vaultId, alias.stableNoteId), alias);
    this.byVaultPath.set(this.pathKey(alias.vaultId, alias.relativePath), alias);
  }

  getBySessionPageId(pageId: string): DesktopIdentityAlias | null {
    return this.bySessionPageId.get(pageId) ?? null;
  }

  getByStableNoteId(stableNoteId: string): DesktopIdentityAlias | null {
    for (const alias of this.bySessionPageId.values()) {
      if (alias.stableNoteId === stableNoteId) return alias;
    }
    return null;
  }

  getByRelativePath(
    vaultId: string,
    relativePath: string,
  ): DesktopIdentityAlias | null {
    return this.byVaultPath.get(this.pathKey(vaultId, relativePath)) ?? null;
  }

  clearVault(vaultId: string): void {
    for (const alias of [...this.bySessionPageId.values()]) {
      if (alias.vaultId !== vaultId) continue;
      this.bySessionPageId.delete(alias.sessionPageId);
      this.byStableNoteId.delete(this.stableKey(alias.vaultId, alias.stableNoteId));
      this.byVaultPath.delete(this.pathKey(alias.vaultId, alias.relativePath));
    }
  }

  clear(): void {
    this.bySessionPageId.clear();
    this.byStableNoteId.clear();
    this.byVaultPath.clear();
  }

  private pathKey(vaultId: string, relativePath: string): string {
    return `${vaultId}\0${relativePath}`;
  }

  private stableKey(vaultId: string, stableNoteId: string): string {
    return `${vaultId}\0${stableNoteId}`;
  }
}
