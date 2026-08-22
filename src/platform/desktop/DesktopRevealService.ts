/**
 * R007 阶段 5（§5.2）：Desktop RevealService——「在文件管理器中显示」
 * 的 IPC-backed 实现。
 *
 * 页面定位复用扫描缓存（findEntry：document 走 stable id/别名解析，
 * group 以 path:<dir> 为 id），解析出 vaultId + relativePath 后交给
 * note.reveal；附件 assetId 自带 vaultId + relativePath 编码，Main 侧
 * 重新解码 + PathGuard（DSK-02：absolutePath 不出 Main）。
 */
import type { RevealService } from "../../application/services/RevealService";
import { DomainError } from "../../domain/errors";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export class DesktopRevealService implements RevealService {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async revealPage(pageId: string): Promise<void> {
    const found = await this.scans.findEntry(pageId);
    if (!found) {
      throw new DomainError("PAGE_NOT_FOUND", "页面不存在，无法定位文件。");
    }
    await this.api.note.reveal({
      vaultId: found.vaultId,
      relativePath: found.entry.relativePath,
    });
  }

  async revealAsset(assetId: string): Promise<void> {
    await this.api.asset.reveal({ assetId });
  }
}
