/**
 * Desktop Asset ID 与 e1-asset:// URL（R006-C5）。
 *
 * 格式：`asset:v1:<encodeURIComponent(vaultId)>/<encodeURIComponent(relativePath)>`
 * - 不含裸绝对路径；
 * - 同 Vault + 同 Path 身份一致；跨 Vault 同 Path 不同；
 * - 不写入 Markdown；Main 使用前必须重新 Vault resolve + PathGuard。
 *
 * 协议：`e1-asset://asset/<encodeURIComponent(assetId)>`
 */

const ID_PREFIX = "asset:v1:";
const PROTOCOL = "e1-asset:";
const HOST = "asset";

export function encodeDesktopAssetId(
  vaultId: string,
  relativePath: string,
): string {
  return `${ID_PREFIX}${encodeURIComponent(vaultId)}/${encodeURIComponent(relativePath)}`;
}

export function decodeDesktopAssetId(
  assetId: string,
): { vaultId: string; relativePath: string } | null {
  if (!assetId.startsWith(ID_PREFIX)) return null;
  const rest = assetId.slice(ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let vaultId: string;
  let relativePath: string;
  try {
    vaultId = decodeURIComponent(rest.slice(0, slash));
    relativePath = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!vaultId || !relativePath) return null;
  if (relativePath.startsWith("/") || relativePath.includes("..")) return null;
  if (relativePath.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }
  return { vaultId, relativePath };
}

export function e1AssetUrl(assetId: string): string {
  return `${PROTOCOL}//${HOST}/${encodeURIComponent(assetId)}`;
}

export type E1AssetUrlParse =
  | { ok: true; assetId: string }
  | { ok: false; reason: "malformed" | "absolute-path" | "query" };

/**
 * 解析 e1-asset URL。拒绝绝对路径、查询串、非 asset host。
 */
export function parseE1AssetUrl(url: string): E1AssetUrlParse {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.protocol !== PROTOCOL) return { ok: false, reason: "malformed" };
  if (parsed.search || parsed.hash) return { ok: false, reason: "query" };
  if (parsed.hostname !== HOST) {
    // e1-asset:///Users/foo.png → hostname 空或被当成路径。
    if (!parsed.hostname || parsed.pathname.startsWith("//")) {
      return { ok: false, reason: "absolute-path" };
    }
    return { ok: false, reason: "malformed" };
  }
  const encoded = parsed.pathname.replace(/^\//, "");
  if (!encoded) return { ok: false, reason: "malformed" };
  let assetId: string;
  try {
    assetId = decodeURIComponent(encoded);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (decodeDesktopAssetId(assetId) === null) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, assetId };
}
