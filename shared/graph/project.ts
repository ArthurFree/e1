/**
 * R015.1：有界 Graph 投影算法（纯函数）。Main SQL 一次取出 docs/links
 * 后在此投影，Renderer 不再 N+1 IPC。
 */
import type {
  GraphEdge,
  GraphFilters,
  GraphNode,
  GraphProjection,
} from "./types.js";
import {
  GRAPH_DEFAULT_EDGE_LIMIT,
  GRAPH_DEFAULT_NODE_LIMIT,
  graphGroupPath,
} from "./types.js";

export interface GraphDocRow {
  noteKey: string;
  title: string;
  relativePath: string;
}

export interface GraphLinkRow {
  sourceNoteKey: string;
  targetNoteKey: string | null;
  href: string;
  label: string;
  broken: boolean;
}

export function graphNodeFromDoc(
  doc: GraphDocRow,
  tags: string[] = [],
): GraphNode {
  return {
    id: doc.noteKey,
    title: doc.title,
    relativePath: doc.relativePath,
    groupPath: graphGroupPath(doc.relativePath),
    tags,
  };
}

function edgeId(
  sourceId: string,
  targetId: string | null,
  href: string,
): string {
  return `${sourceId}->${targetId ?? href}`;
}

function matchesFilters(node: GraphNode, filters?: GraphFilters): boolean {
  if (!filters) return true;
  if (filters.noteKeys && filters.noteKeys.length > 0) {
    if (!filters.noteKeys.includes(node.id)) return false;
  }
  const query = filters.query?.trim().toLowerCase();
  if (query) {
    const hit =
      node.title.toLowerCase().includes(query) ||
      node.relativePath.toLowerCase().includes(query);
    if (!hit) return false;
  }
  if (filters.groupPath) {
    if (node.groupPath !== filters.groupPath) return false;
  }
  if (filters.tag) {
    if (!node.tags.includes(filters.tag)) return false;
  }
  return true;
}

export function projectLocalGraph(input: {
  centerId: string;
  depth: 1 | 2;
  docs: GraphDocRow[];
  links: GraphLinkRow[];
  nodeLimit?: number;
  edgeLimit?: number;
  includeBroken?: boolean;
  tagsById?: ReadonlyMap<string, string[]>;
}): GraphProjection {
  const nodeLimit = Math.min(
    input.nodeLimit ?? GRAPH_DEFAULT_NODE_LIMIT,
    GRAPH_DEFAULT_NODE_LIMIT,
  );
  const edgeLimit = Math.min(
    input.edgeLimit ?? GRAPH_DEFAULT_EDGE_LIMIT,
    GRAPH_DEFAULT_EDGE_LIMIT,
  );
  const includeBroken = input.includeBroken !== false;
  const docs = new Map(input.docs.map((d) => [d.noteKey, d]));
  const tagsById = input.tagsById;
  const nodeOf = (id: string, titleHint?: string): GraphNode => {
    const doc = docs.get(id);
    if (doc) return graphNodeFromDoc(doc, tagsById?.get(id) ?? []);
    return {
      id,
      title: titleHint ?? id,
      relativePath: "",
      groupPath: null,
      tags: tagsById?.get(id) ?? [],
    };
  };

  const outgoing = new Map<string, GraphLinkRow[]>();
  const incoming = new Map<string, GraphLinkRow[]>();
  for (const link of input.links) {
    if (!includeBroken && link.broken) continue;
    const outs = outgoing.get(link.sourceNoteKey) ?? [];
    outs.push(link);
    outgoing.set(link.sourceNoteKey, outs);
    if (!link.broken && link.targetNoteKey) {
      const ins = incoming.get(link.targetNoteKey) ?? [];
      ins.push(link);
      incoming.set(link.targetNoteKey, ins);
    }
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;

  const pushNode = (node: GraphNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= nodeLimit) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const pushEdge = (edge: GraphEdge): boolean => {
    if (edges.has(edge.id)) return true;
    if (edges.size >= edgeLimit) {
      truncated = true;
      return false;
    }
    edges.set(edge.id, edge);
    return true;
  };

  const collect = (pageId: string): string[] => {
    const neighborIds: string[] = [];
    for (const link of outgoing.get(pageId) ?? []) {
      const targetId = link.broken ? null : link.targetNoteKey;
      pushEdge({
        id: edgeId(pageId, targetId, link.href),
        sourceId: pageId,
        targetId,
        direction: "outgoing",
        state: link.broken ? "broken" : "resolved",
        href: link.href,
        label: link.label,
      });
      if (targetId) {
        neighborIds.push(targetId);
        pushNode(nodeOf(targetId, link.label));
      }
    }
    for (const link of incoming.get(pageId) ?? []) {
      pushEdge({
        id: edgeId(link.sourceNoteKey, pageId, link.href),
        sourceId: link.sourceNoteKey,
        targetId: pageId,
        direction: "outgoing",
        state: "resolved",
        href: link.href,
        label: link.label,
      });
      neighborIds.push(link.sourceNoteKey);
      const src = docs.get(link.sourceNoteKey);
      pushNode(nodeOf(link.sourceNoteKey, src?.title ?? link.label));
    }
    return [...new Set(neighborIds)];
  };

  pushNode(nodeOf(input.centerId));
  const first = collect(input.centerId);
  if (input.depth === 2) {
    for (const neighborId of first) collect(neighborId);
  }
  return {
    centerNodeId: input.centerId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
  };
}

export function projectWorkspaceGraph(input: {
  docs: GraphDocRow[];
  links: GraphLinkRow[];
  orphanIds?: ReadonlySet<string>;
  nodeLimit?: number;
  edgeLimit?: number;
  filters?: GraphFilters;
  tagsById?: ReadonlyMap<string, string[]>;
}): GraphProjection {
  const nodeLimit = Math.min(
    input.nodeLimit ?? GRAPH_DEFAULT_NODE_LIMIT,
    GRAPH_DEFAULT_NODE_LIMIT,
  );
  const edgeLimit = Math.min(
    input.edgeLimit ?? GRAPH_DEFAULT_EDGE_LIMIT,
    GRAPH_DEFAULT_EDGE_LIMIT,
  );
  const includeBroken = input.filters?.includeBroken !== false;
  const tagsById = input.tagsById;
  let catalog = input.docs.map((d) =>
    graphNodeFromDoc(d, tagsById?.get(d.noteKey) ?? []),
  );
  const totalNodeCount = catalog.length;
  catalog = catalog.filter((n) => matchesFilters(n, input.filters));
  if (input.filters?.orphansOnly && input.orphanIds) {
    catalog = catalog.filter((n) => input.orphanIds!.has(n.id));
  }
  const truncatedNodes = catalog.length > nodeLimit;
  const chosen = catalog.slice(0, nodeLimit);
  const nodes = new Map(chosen.map((n) => [n.id, n]));
  const edges = new Map<string, GraphEdge>();
  let truncated = truncatedNodes;
  const chosenIds = new Set(chosen.map((n) => n.id));

  for (const link of input.links) {
    if (!chosenIds.has(link.sourceNoteKey)) continue;
    if (!includeBroken && link.broken) continue;
    if (edges.size >= edgeLimit) {
      truncated = true;
      break;
    }
    const targetId = link.broken ? null : link.targetNoteKey;
    const id = edgeId(link.sourceNoteKey, targetId, link.href);
    if (edges.has(id)) continue;
    edges.set(id, {
      id,
      sourceId: link.sourceNoteKey,
      targetId,
      direction: "outgoing",
      state: link.broken ? "broken" : "resolved",
      href: link.href,
      label: link.label,
    });
    if (targetId && !nodes.has(targetId)) {
      const doc = input.docs.find((d) => d.noteKey === targetId);
      if (doc && nodes.size < nodeLimit) {
        nodes.set(
          targetId,
          graphNodeFromDoc(doc, tagsById?.get(targetId) ?? []),
        );
      } else if (!doc) {
        truncated = true;
      } else {
        truncated = true;
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
    totalNodeCount,
    totalEdgeCount: edges.size,
  };
}

export function projectOrphans(input: {
  docs: GraphDocRow[];
  links: GraphLinkRow[];
  limit?: number;
  tagsById?: ReadonlyMap<string, string[]>;
}): GraphNode[] {
  const resolvedOut = new Set<string>();
  const resolvedIn = new Set<string>();
  for (const link of input.links) {
    if (link.broken || !link.targetNoteKey) continue;
    resolvedOut.add(link.sourceNoteKey);
    resolvedIn.add(link.targetNoteKey);
  }
  const limit = input.limit ?? GRAPH_DEFAULT_NODE_LIMIT;
  const orphans: GraphNode[] = [];
  for (const doc of input.docs) {
    if (orphans.length >= limit) break;
    if (!resolvedOut.has(doc.noteKey) && !resolvedIn.has(doc.noteKey)) {
      orphans.push(
        graphNodeFromDoc(doc, input.tagsById?.get(doc.noteKey) ?? []),
      );
    }
  }
  return orphans;
}
