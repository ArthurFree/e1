/**
 * R008 Stage 2（§9，R8-07）：Desktop 的 RevealService 实现——
 * 会话身份（pageId/assetId）→ 会话缓存反查 {vaultId, relativePath} →
 * 经桌面桥 note.reveal / asset.reveal 走 Main 安全链路（授权边界 +
 * PathGuard + shell.showItemInFolder）。本层不接触 absolutePath。
 *
 * 反查来源：
 * - 文档：DesktopDocumentSourceCache（打开时记录的 pageId → relativePath，
 *   外部移动后由 ExternalVaultChangeService 同步，保存链路同一真相）；
 * - 附件：DesktopAssetRegistry（导入/Hydration 登记的 assetId →
 *   vaultId + relativePath）。
 * 反查缺失或 IPC 失败一律归一为 false（UI 只提示「无法定位」级别文案，
 * 不泄露路径）。
 */
import type { RevealService } from "../../application/services/RevealService";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";

export class DesktopRevealService implements RevealService {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly sources: DesktopDocumentSourceCache,
    private readonly assets: DesktopAssetRegistry,
  ) {}

  async revealDocument(pageId: string): Promise<boolean> {
    const source = this.sources.get(pageId);
    if (!source) return false;
    try {
      await this.api.note.reveal({
        vaultId: source.vaultId,
        relativePath: source.relativePath,
      });
      return true;
    } catch {
      return false;
    }
  }

  async revealAsset(assetId: string): Promise<boolean> {
    const record = this.assets.get(assetId);
    if (!record) return false;
    try {
      await this.api.asset.reveal({
        vaultId: record.vaultId,
        relativePath: record.relativePath,
      });
      return true;
    } catch {
      return false;
    }
  }
}
