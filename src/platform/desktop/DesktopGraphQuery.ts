/**
 * R015：Desktop GraphQueryPort——LinkIndex 投影 + 扫描目录元数据。
 * UI 不碰 SQL / 文件系统（GRAPH-06）。
 */
import type { GraphQueryPort } from "../../application/graph/GraphQueryPort";
import { GraphProjectionService } from "../../application/graph/GraphProjectionService";
import { nodeFromPath } from "../../application/graph/GraphProjectionService";
import type { LinkIndex } from "../../application/links/LinkIndex";
import { pageIdOfEntry } from "./vaultMapping";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export function createDesktopGraphQuery(
  linkIndex: LinkIndex,
  scans: DesktopVaultScanCache,
): GraphQueryPort {
  return new GraphProjectionService(linkIndex, {
    async getNode(vaultId, pageId) {
      const snap = await scans.scan(vaultId);
      const rel = scans.lookupRelativePath(pageId);
      const entry = snap.result.entries.find(
        (e) =>
          e.kind === "document" &&
          (pageIdOfEntry(e) === pageId || e.relativePath === rel),
      );
      if (!entry) return rel ? nodeFromPath(pageId, pageId, rel) : null;
      return nodeFromPath(pageId, entry.title, entry.relativePath);
    },
    async listDocumentNodes(vaultId) {
      const snap = await scans.scan(vaultId);
      return snap.result.entries
        .filter((e) => e.kind === "document")
        .map((e) =>
          nodeFromPath(pageIdOfEntry(e), e.title, e.relativePath),
        );
    },
  });
}
