/**
 * R015：LinkIndex → Graph 投影。只读邻域/有界全库查询，失败不影响保存。
 * R015.1：投影算法在 shared/graph/project.ts；本类只装配 LinkIndex 快照。
 */
import type { LinkIndex } from "../links/LinkIndex";
import type { DocumentLink } from "../links/LinkIndex";
import type {
  GraphFilters,
  GraphNode,
  GraphProjection,
  GraphQueryPort,
} from "./GraphQueryPort";
import {
  GRAPH_DEFAULT_EDGE_LIMIT,
  GRAPH_DEFAULT_NODE_LIMIT,
} from "./GraphQueryPort";
import {
  graphNodeFromDoc,
  projectLocalGraph,
  projectOrphans,
  projectWorkspaceGraph,
  type GraphDocRow,
  type GraphLinkRow,
} from "../../../shared/graph/project";
import { graphGroupPath } from "../../../shared/graph/types";

export interface GraphNodeCatalog {
  getNode(vaultId: string, pageId: string): Promise<GraphNode | null>;
  listDocumentNodes(vaultId: string): Promise<GraphNode[]>;
}

function asInternal(links: DocumentLink[]): GraphLinkRow[] {
  return links
    .filter((link) => link.kind === "internal")
    .map((link) => ({
      sourceNoteKey: link.sourcePageId,
      targetNoteKey: link.targetPageId,
      href: link.href,
      label: link.label,
      broken: link.broken,
    }));
}

export class GraphProjectionService implements GraphQueryPort {
  constructor(
    private readonly linkIndex: LinkIndex,
    private readonly catalog: GraphNodeCatalog,
  ) {}

  private async ensureReady(vaultId: string): Promise<void> {
    try {
      await this.linkIndex.prepare(vaultId);
    } catch {
      // GRAPH-04：图谱失败不得阻断主路径。
    }
  }

  private async snapshot(vaultId: string): Promise<{
    docs: GraphDocRow[];
    links: GraphLinkRow[];
    tagsById: Map<string, string[]>;
  }> {
    const catalog = await this.catalog.listDocumentNodes(vaultId);
    const docs: GraphDocRow[] = catalog.map((n) => ({
      noteKey: n.id,
      title: n.title,
      relativePath: n.relativePath,
    }));
    const tagsById = new Map(catalog.map((n) => [n.id, n.tags]));
    const links: GraphLinkRow[] = [];
    for (const node of catalog) {
      try {
        links.push(
          ...asInternal(
            await this.linkIndex.getOutgoing({
              vaultId,
              noteKey: node.id,
            }),
          ),
        );
      } catch {
        // GRAPH-04
      }
    }
    return { docs, links, tagsById };
  }

  async getLocalGraph(input: {
    vaultId: string;
    pageId: string;
    depth: 1 | 2;
    nodeLimit: number;
    edgeLimit: number;
    includeBroken: boolean;
  }): Promise<GraphProjection> {
    await this.ensureReady(input.vaultId);
    const snap = await this.snapshot(input.vaultId);
    return projectLocalGraph({
      centerId: input.pageId,
      depth: input.depth,
      docs: snap.docs,
      links: snap.links,
      nodeLimit: Math.min(input.nodeLimit, GRAPH_DEFAULT_NODE_LIMIT),
      edgeLimit: Math.min(input.edgeLimit, GRAPH_DEFAULT_EDGE_LIMIT),
      includeBroken: input.includeBroken,
      tagsById: snap.tagsById,
    });
  }

  async getWorkspaceGraph(input: {
    vaultId: string;
    nodeLimit: number;
    edgeLimit: number;
    filters?: GraphFilters;
  }): Promise<GraphProjection> {
    await this.ensureReady(input.vaultId);
    const snap = await this.snapshot(input.vaultId);
    const orphans = projectOrphans({
      docs: snap.docs,
      links: snap.links,
      tagsById: snap.tagsById,
    });
    return projectWorkspaceGraph({
      docs: snap.docs,
      links: snap.links,
      orphanIds: new Set(orphans.map((n) => n.id)),
      nodeLimit: Math.min(input.nodeLimit, GRAPH_DEFAULT_NODE_LIMIT),
      edgeLimit: Math.min(input.edgeLimit, GRAPH_DEFAULT_EDGE_LIMIT),
      filters: input.filters,
      tagsById: snap.tagsById,
    });
  }

  async getOrphans(input: {
    vaultId: string;
    limit?: number;
  }): Promise<GraphNode[]> {
    await this.ensureReady(input.vaultId);
    const snap = await this.snapshot(input.vaultId);
    return projectOrphans({
      docs: snap.docs,
      links: snap.links,
      limit: input.limit,
      tagsById: snap.tagsById,
    });
  }
}

export function nodeFromPath(
  id: string,
  title: string,
  relativePath: string,
  tags: readonly string[] = [],
): GraphNode {
  return graphNodeFromDoc({ noteKey: id, title, relativePath }, [...tags]);
}

export { graphGroupPath };
