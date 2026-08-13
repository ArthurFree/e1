/**
 * e1-asset 协议的纯解析与读盘（不依赖 Electron protocol API）。
 * 注册特权协议 / protocol.handle 见 e1AssetProtocol.ts。
 */
import {
  decodeDesktopAssetId,
  parseE1AssetUrl,
} from "../../../shared/assets/desktopAssetId.js";
import { readAssetFile } from "../filesystem/AssetFileSystem.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { IpcFailure } from "../../../shared/errors.js";

export async function serveE1Asset(
  url: string,
  deps: VaultRootDeps,
): Promise<{ status: number; data?: Uint8Array; mimeType?: string }> {
  const parsed = parseE1AssetUrl(url);
  if (!parsed.ok) {
    return { status: 400 };
  }
  const decoded = decodeDesktopAssetId(parsed.assetId);
  if (!decoded) return { status: 400 };
  try {
    const root = await resolveVaultRoot(decoded.vaultId, deps);
    const file = await readAssetFile({
      vaultRoot: root.absolutePath,
      relativePath: decoded.relativePath,
    });
    return { status: 200, data: file.data, mimeType: file.mimeType };
  } catch (err) {
    if (err instanceof IpcFailure && err.code === "ASSET_NOT_FOUND") {
      return { status: 404 };
    }
    if (err instanceof IpcFailure && err.code === "PATH_ESCAPE") {
      return { status: 400 };
    }
    return { status: 404 };
  }
}
