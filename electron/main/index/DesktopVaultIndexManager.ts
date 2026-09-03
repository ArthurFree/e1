/**
 * R010 Stage 3（§17 实施决策）：per-vault 索引库管理器——
 * Search 与 Link 两个逻辑表组共用同一 VaultIndexConnection（单
 * DatabaseSync 指向同一物理文件），避免双连接 SQLITE_BUSY 写冲突；
 * 文件路径沿用 search-index/<vaultId>.sqlite（索引是 derived data，
 * 既有搜索库就地增加 links 表组，损坏/版本不兼容整体备份重建）。
 *
 * 结构对齐 DesktopSearchIndexManager（按 vault 懒建 + closeAll），
 * searchFor/searchAll 保持搜索 handler 既有消费形状；linksFor 供
 * link 组 handler 使用。
 */
import {
  DesktopSearchDatabase,
  searchIndexFilePath,
  type SearchQueryRowOut,
} from "../search/DesktopSearchDatabase.js";
import { compareSearchResults } from "../../../shared/search/textMatch.js";
import { DesktopLinkDatabase } from "../links/DesktopLinkDatabase.js";
import { VaultIndexConnection } from "./VaultIndexConnection.js";

interface VaultIndexEntry {
  connection: VaultIndexConnection;
  search: DesktopSearchDatabase;
  link: DesktopLinkDatabase;
}

/** 按 Vault 管理的索引库集合（Search + Link 共库单连接）。 */
export class DesktopVaultIndexManager {
  private readonly entries = new Map<string, VaultIndexEntry>();

  constructor(private readonly baseDir: string) {}

  private entry(vaultId: string): VaultIndexEntry {
    let entry = this.entries.get(vaultId);
    if (!entry) {
      const connection = new VaultIndexConnection(
        searchIndexFilePath(this.baseDir, vaultId),
      );
      entry = {
        connection,
        search: new DesktopSearchDatabase(connection),
        link: new DesktopLinkDatabase(connection),
      };
      this.entries.set(vaultId, entry);
    }
    return entry;
  }

  /** 搜索表组（与 DesktopSearchIndexManager.forVault 同义）。 */
  searchFor(vaultId: string): DesktopSearchDatabase {
    return this.entry(vaultId).search;
  }

  /** 链接表组（R010 Stage 3）。 */
  linksFor(vaultId: string): DesktopLinkDatabase {
    return this.entry(vaultId).link;
  }

  /** 跨库检索（vaultId 缺省）：逐库查询后合并重排（仅覆盖已打开的索引库）。 */
  async searchAll(input: {
    query: string;
    limit?: number;
  }): Promise<SearchQueryRowOut[]> {
    const limit = Math.min(input.limit ?? 50, 100);
    const all: SearchQueryRowOut[] = [];
    for (const entry of this.entries.values()) {
      all.push(...(await entry.search.search({ query: input.query, limit })));
    }
    all.sort(compareSearchResults);
    return all.slice(0, limit);
  }

  closeAll(): void {
    for (const entry of this.entries.values()) entry.connection.close();
    this.entries.clear();
  }
}
