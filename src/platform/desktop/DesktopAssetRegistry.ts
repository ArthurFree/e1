/**
 * R006-C5 FR-26：Session 派生的资源索引。不写磁盘、不写 localStorage。
 * Asset ID 由 Main 分配（vaultId + relativePath），本表只做 Session 查找。
 */
export interface DesktopAssetRecord {
  id: string;
  vaultId: string;
  relativePath: string;
  name: string;
  mimeType: string;
  size: number;
  pageId: string;
}

export class DesktopAssetRegistry {
  private readonly byId = new Map<string, DesktopAssetRecord>();
  private readonly byVaultPath = new Map<string, string>();

  private pathKey(vaultId: string, relativePath: string): string {
    return `${vaultId}\0${relativePath}`;
  }

  register(record: DesktopAssetRecord): void {
    this.byId.set(record.id, record);
    this.byVaultPath.set(this.pathKey(record.vaultId, record.relativePath), record.id);
  }

  get(id: string): DesktopAssetRecord | undefined {
    return this.byId.get(id);
  }

  findByPath(vaultId: string, relativePath: string): DesktopAssetRecord | undefined {
    const id = this.byVaultPath.get(this.pathKey(vaultId, relativePath));
    return id ? this.byId.get(id) : undefined;
  }

  listByDocument(pageId: string): DesktopAssetRecord[] {
    return [...this.byId.values()].filter((record) => record.pageId === pageId);
  }

  /** 删除 Session 引用，不碰物理文件（PR-05）。 */
  removeSessionReference(id: string): void {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.delete(id);
    this.byVaultPath.delete(this.pathKey(existing.vaultId, existing.relativePath));
  }

  clearVault(vaultId: string): void {
    for (const [id, record] of this.byId) {
      if (record.vaultId !== vaultId) continue;
      this.byId.delete(id);
      this.byVaultPath.delete(this.pathKey(record.vaultId, record.relativePath));
    }
  }
}
