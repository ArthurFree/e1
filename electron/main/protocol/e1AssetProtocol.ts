/**
 * e1-asset:// 自定义协议（R006-C5 FR-21~24）。
 *
 * 必须在 app.ready 之前 registerSchemesAsPrivileged；
 * handle 在 ready 之后注册。拒绝绝对路径与查询串；missing → 404。
 */
import { protocol } from "electron";
import type { VaultRootDeps } from "../vaultRoots.js";
import { serveE1Asset } from "./serveE1Asset.js";

export { serveE1Asset } from "./serveE1Asset.js";

export function registerE1AssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "e1-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function registerE1AssetProtocol(deps: VaultRootDeps): void {
  protocol.handle("e1-asset", async (request) => {
    const result = await serveE1Asset(request.url, deps);
    if (result.status === 200 && result.data) {
      return new Response(Buffer.from(result.data), {
        status: 200,
        headers: {
          "Content-Type": result.mimeType ?? "application/octet-stream",
        },
      });
    }
    return new Response(null, { status: result.status });
  });
}
