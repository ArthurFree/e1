/**
 * R015.1：Desktop GraphQueryPort——一次 IPC 取邻域/工作区投影，
 * 扫描缓存合并真实 tags / groupPath。UI 不碰 SQL / 文件系统（GRAPH-06）。
 */
import type {
  GraphFilters,
  GraphNode,
  GraphProjection,
  GraphQueryPort,
} from "../../application/graph/GraphQueryPort";
import { graphGroupPath } from "../../../shared/graph/types";
import type { LinkIndex } from "../../application/links/LinkIndex";
import type { E1DesktopAPI, VaultScanEntry } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import { pageIdOfEntry } from "./vaultMapping";

export function createDesktopGraphQuery(
  api: E1DesktopAPI,
  linkIndex: LinkIndex,
  scans: DesktopVaultScanCache,
): GraphQueryPort {
  const toNoteKey = (vaultId: string, pageId: string): string => {
    const alias = scans.aliases.getBySessionPageId(pageId);
    return alias?.vaultId === vaultId ? alias.stableNoteId : pageId;
  };

  const toSessionPageId = (vaultId: string, key: string): string => {
    const alias = key.startsWith("path:")
      ? scans.aliases.getByRelativePath(vaultId, key.slice("path:".length))
      : scans.aliases.getByStableNoteId(key);
    return alias?.vaultId === vaultId ? alias.sessionPageId : key;
  };

  const hydrateNode = (
    vaultId: string,
    node: GraphNode,
    entries: readonly VaultScanEntry[],
  ): GraphNode => {
    const id = toSessionPageId(vaultId, node.id);
    const entry = entries.find(
      (e) =>
        e.kind === "document" &&
        (pageIdOfEntry(e) === id ||
          pageIdOfEntry(e) === node.id ||
          e.relativePath === node.relativePath),
    );
    const tags = entry?.tags ?? node.tags;
    const relativePath = entry?.relativePath ?? node.relativePath;
    return {
      ...node,
      id,
      title: entry?.title ?? node.title,
      relativePath,
      groupPath: graphGroupPath(relativePath),
      tags,
    };
  };

  const hydrate = async (
    vaultId: string,
    projection: GraphProjection,
  ): Promise<GraphProjection> => {
    const snap = await scans.scan(vaultId);
    const nodes = projection.nodes.map((node) =>
      hydrateNode(vaultId, node, snap.result.entries),
    );
    const idMap = new Map(
      projection.nodes.map((node, index) => [node.id, nodes[index]!.id]),
    );
    return {
      ...projection,
      centerNodeId: projection.centerNodeId
        ? (idMap.get(projection.centerNodeId) ??
          toSessionPageId(vaultId, projection.centerNodeId))
        : projection.centerNodeId,
      nodes,
      edges: projection.edges.map((edge) => ({
        ...edge,
        sourceId:
          idMap.get(edge.sourceId) ?? toSessionPageId(vaultId, edge.sourceId),
        targetId:
          edge.targetId === null
            ? null
            : (idMap.get(edge.targetId) ??
              toSessionPageId(vaultId, edge.targetId)),
      })),
    };
  };

  return {
    async getLocalGraph(input) {
      try {
        await linkIndex.prepare(input.vaultId);
      } catch {
        // GRAPH-04
      }
      const raw = await api.graph.neighborhood({
        vaultId: input.vaultId,
        noteKey: toNoteKey(input.vaultId, input.pageId),
        depth: input.depth,
        nodeLimit: input.nodeLimit,
        edgeLimit: input.edgeLimit,
        includeBroken: input.includeBroken,
      });
      return hydrate(input.vaultId, raw);
    },

    async getWorkspaceGraph(input) {
      try {
        await linkIndex.prepare(input.vaultId);
      } catch {
        // GRAPH-04
      }
      let filters: GraphFilters | undefined = input.filters;
      if (filters?.tag) {
        const snap = await scans.scan(input.vaultId);
        const keys = snap.result.entries
          .filter(
            (entry) =>
              entry.kind === "document" && entry.tags.includes(filters!.tag!),
          )
          .map((entry) => toNoteKey(input.vaultId, pageIdOfEntry(entry)));
        // tag 已在 Renderer 侧经扫描快照翻译成 noteKeys；Main 投影没有
        // tagsById（节点 tags 恒为 []），必须把 tag 字段一并移除，
        // 否则投影侧 tag 检查会把所有节点滤掉。
        const translated: GraphFilters = {
          ...filters,
          noteKeys: keys.length > 0 ? keys : ["__no_match__"],
        };
        delete translated.tag;
        filters = translated;
      }
      const raw = await api.graph.workspace({
        vaultId: input.vaultId,
        nodeLimit: input.nodeLimit,
        edgeLimit: input.edgeLimit,
        filters,
      });
      return hydrate(input.vaultId, raw);
    },

    async getOrphans(input) {
      try {
        await linkIndex.prepare(input.vaultId);
      } catch {
        // GRAPH-04
      }
      const snap = await scans.scan(input.vaultId);
      const rows = await api.graph.orphans({
        vaultId: input.vaultId,
        limit: input.limit,
      });
      return rows.map((node) =>
        hydrateNode(input.vaultId, node, snap.result.entries),
      );
    },
  };
}
