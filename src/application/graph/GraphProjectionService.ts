/**
 * R015：LinkIndex → Graph 投影。只读邻域/有界全库查询，失败不影响保存。
 */
import type { LinkIndex } from "../links/LinkIndex";
import type { DocumentLink } from "../links/LinkIndex";
import type {
  GraphEdge,
  GraphFilters,
  GraphNode,
  GraphProjection,
  GraphQueryPort,
} from "./GraphQueryPort";
import {
  GRAPH_DEFAULT_EDGE_LIMIT,
  GRAPH_DEFAULT_NODE_LIMIT,
} from "./GraphQueryPort";

export interface GraphNodeCatalog {
  getNode(vaultId: string, pageId: string): Promise<GraphNode | null>;
  listDocumentNodes(vaultId: string): Promise<GraphNode[]>;
}

function parentPath(relativePath: string): string | null {
  const i = relativePath.lastIndexOf("/");
  return i <= 0 ? null : relativePath.slice(0, i);
}

function edgeId(sourceId: string, targetId: string | null, href: string): string {
  return `${sourceId}->${targetId ?? href}`;
}

function asInternalEdges(links: DocumentLink[], includeBroken: boolean): DocumentLink[] {
  return links.filter((link) => {
    if (link.kind !== "internal") return false;
    if (link.broken) return includeBroken;
    return true;
  });
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

  private async nodeOrFallback(
    vaultId: string,
    pageId: string,
    titleHint?: string,
  ): Promise<GraphNode> {
    const found = await this.catalog.getNode(vaultId, pageId);
    if (found) return found;
    return {
      id: pageId,
      title: titleHint ?? pageId,
      relativePath: "",
      groupPath: null,
      tags: [],
    };
  }

  private pushNode(
    nodes: Map<string, GraphNode>,
    node: GraphNode,
    nodeLimit: number,
  ): boolean {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= nodeLimit) return false;
    nodes.set(node.id, node);
    return true;
  }

  private pushEdge(
    edges: Map<string, GraphEdge>,
    edge: GraphEdge,
    edgeLimit: number,
  ): boolean {
    if (edges.has(edge.id)) return true;
    if (edges.size >= edgeLimit) return false;
    edges.set(edge.id, edge);
    return true;
  }

  private async collectAround(
    vaultId: string,
    pageId: string,
    includeBroken: boolean,
    nodes: Map<string, GraphNode>,
    edges: Map<string, GraphEdge>,
    nodeLimit: number,
    edgeLimit: number,
  ): Promise<{ truncated: boolean; neighborIds: string[] }> {
    let truncated = false;
    const neighborIds: string[] = [];
    let outgoing: DocumentLink[];
    let backlinks: Awaited<ReturnType<LinkIndex["getBacklinks"]>>;
    try {
      outgoing = asInternalEdges(
        await this.linkIndex.getOutgoing({ vaultId, noteKey: pageId }),
        includeBroken,
      );
      backlinks = await this.linkIndex.getBacklinks({ vaultId, noteKey: pageId });
    } catch {
      return { truncated: false, neighborIds };
    }

    for (const link of outgoing) {
      const targetId = link.broken ? null : link.targetPageId;
      const edge: GraphEdge = {
        id: edgeId(pageId, targetId, link.href),
        sourceId: pageId,
        targetId,
        direction: "outgoing",
        state: link.broken ? "broken" : "resolved",
        href: link.href,
        label: link.label,
      };
      if (!this.pushEdge(edges, edge, edgeLimit)) truncated = true;
      if (targetId) {
        neighborIds.push(targetId);
        const node = await this.nodeOrFallback(vaultId, targetId, link.label);
        if (!this.pushNode(nodes, node, nodeLimit)) truncated = true;
      }
    }

    for (const back of backlinks) {
      const edge: GraphEdge = {
        id: edgeId(back.sourcePageId, pageId, back.href),
        sourceId: back.sourcePageId,
        targetId: pageId,
        direction: "outgoing",
        state: "resolved",
        href: back.href,
      };
      if (!this.pushEdge(edges, edge, edgeLimit)) truncated = true;
      neighborIds.push(back.sourcePageId);
      const node = await this.nodeOrFallback(
        vaultId,
        back.sourcePageId,
        back.sourceTitle,
      );
      if (!this.pushNode(nodes, node, nodeLimit)) truncated = true;
    }

    return { truncated, neighborIds: [...new Set(neighborIds)] };
  }

  async getLocalGraph(input: {
    vaultId: string;
    pageId: string;
    depth: 1 | 2;
    nodeLimit: number;
    edgeLimit: number;
    includeBroken: boolean;
  }): Promise<GraphProjection> {
    const nodeLimit = Math.min(input.nodeLimit, GRAPH_DEFAULT_NODE_LIMIT);
    const edgeLimit = Math.min(input.edgeLimit, GRAPH_DEFAULT_EDGE_LIMIT);
    await this.ensureReady(input.vaultId);
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const center = await this.nodeOrFallback(input.vaultId, input.pageId);
    this.pushNode(nodes, center, nodeLimit);
    const first = await this.collectAround(
      input.vaultId,
      input.pageId,
      input.includeBroken,
      nodes,
      edges,
      nodeLimit,
      edgeLimit,
    );
    let truncated = first.truncated;
    if (input.depth === 2) {
      for (const neighborId of first.neighborIds) {
        const next = await this.collectAround(
          input.vaultId,
          neighborId,
          input.includeBroken,
          nodes,
          edges,
          nodeLimit,
          edgeLimit,
        );
        if (next.truncated) truncated = true;
      }
    }
    return {
      centerNodeId: input.pageId,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated,
    };
  }

  async getWorkspaceGraph(input: {
    vaultId: string;
    nodeLimit: number;
    edgeLimit: number;
    filters?: GraphFilters;
  }): Promise<GraphProjection> {
    const nodeLimit = Math.min(input.nodeLimit, GRAPH_DEFAULT_NODE_LIMIT);
    const edgeLimit = Math.min(input.edgeLimit, GRAPH_DEFAULT_EDGE_LIMIT);
    const includeBroken = input.filters?.includeBroken !== false;
    await this.ensureReady(input.vaultId);
    let catalog = await this.catalog.listDocumentNodes(input.vaultId);
    const totalNodeCount = catalog.length;
    const query = input.filters?.query?.trim().toLowerCase();
    if (query) {
      catalog = catalog.filter(
        (n) =>
          n.title.toLowerCase().includes(query) ||
          n.relativePath.toLowerCase().includes(query),
      );
    }
    if (input.filters?.orphansOnly) {
      const orphans = await this.getOrphans({
        vaultId: input.vaultId,
        limit: nodeLimit,
      });
      const orphanIds = new Set(orphans.map((n) => n.id));
      catalog = catalog.filter((n) => orphanIds.has(n.id));
    }
    const truncatedNodes = catalog.length > nodeLimit;
    const chosen = catalog.slice(0, nodeLimit);
    const nodes = new Map(chosen.map((n) => [n.id, n]));
    const edges = new Map<string, GraphEdge>();
    let truncated = truncatedNodes;
    for (const node of chosen) {
      let outgoing: DocumentLink[];
      try {
        outgoing = asInternalEdges(
          await this.linkIndex.getOutgoing({
            vaultId: input.vaultId,
            noteKey: node.id,
          }),
          includeBroken,
        );
      } catch {
        continue;
      }
      for (const link of outgoing) {
        const targetId = link.broken ? null : link.targetPageId;
        if (
          !this.pushEdge(
            edges,
            {
              id: edgeId(node.id, targetId, link.href),
              sourceId: node.id,
              targetId,
              direction: "outgoing",
              state: link.broken ? "broken" : "resolved",
              href: link.href,
              label: link.label,
            },
            edgeLimit,
          )
        ) {
          truncated = true;
          break;
        }
        if (targetId && !nodes.has(targetId)) {
          const target = await this.nodeOrFallback(
            input.vaultId,
            targetId,
            link.label,
          );
          if (!this.pushNode(nodes, target, nodeLimit)) truncated = true;
        }
      }
      if (truncated && edges.size >= edgeLimit) break;
    }
    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated,
      totalNodeCount,
      totalEdgeCount: edges.size,
    };
  }

  async getOrphans(input: {
    vaultId: string;
    limit?: number;
  }): Promise<GraphNode[]> {
    const limit = input.limit ?? GRAPH_DEFAULT_NODE_LIMIT;
    await this.ensureReady(input.vaultId);
    const catalog = await this.catalog.listDocumentNodes(input.vaultId);
    const orphans: GraphNode[] = [];
    for (const node of catalog) {
      if (orphans.length >= limit) break;
      let outgoing: DocumentLink[];
      let backlinks: Awaited<ReturnType<LinkIndex["getBacklinks"]>>;
      try {
        outgoing = await this.linkIndex.getOutgoing({
          vaultId: input.vaultId,
          noteKey: node.id,
        });
        backlinks = await this.linkIndex.getBacklinks({
          vaultId: input.vaultId,
          noteKey: node.id,
        });
      } catch {
        continue;
      }
      const resolvedOut = outgoing.some(
        (l) => l.kind === "internal" && !l.broken && l.targetPageId,
      );
      const resolvedIn = backlinks.length > 0;
      if (!resolvedOut && !resolvedIn) orphans.push(node);
    }
    return orphans;
  }
}

export function nodeFromPath(
  id: string,
  title: string,
  relativePath: string,
): GraphNode {
  return {
    id,
    title,
    relativePath,
    groupPath: parentPath(relativePath),
    tags: [],
  };
}
