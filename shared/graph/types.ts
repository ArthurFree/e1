/**
 * R015：知识图谱投影契约。Graph 是 LinkIndex 的可丢弃投影（GRAPH-01/09）。
 * nodeId = stablePageId（GRAPH-02）；禁止按 title 解析身份（GRAPH-03）。
 * broken 是边状态，不虚构文档节点（GRAPH-08）。
 */
export interface GraphNode {
  id: string;
  title: string;
  relativePath: string;
  groupPath: string | null;
  tags: string[];
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string | null;
  direction: "outgoing";
  state: "resolved" | "broken";
  href: string;
  label?: string;
}

export interface GraphProjection {
  centerNodeId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  totalNodeCount?: number;
  totalEdgeCount?: number;
}

export interface GraphFilters {
  query?: string;
  includeBroken?: boolean;
  orphansOnly?: boolean;
}

export interface GraphQueryPort {
  getLocalGraph(input: {
    vaultId: string;
    pageId: string;
    depth: 1 | 2;
    nodeLimit: number;
    edgeLimit: number;
    includeBroken: boolean;
  }): Promise<GraphProjection>;

  getWorkspaceGraph(input: {
    vaultId: string;
    nodeLimit: number;
    edgeLimit: number;
    filters?: GraphFilters;
  }): Promise<GraphProjection>;

  getOrphans(input: { vaultId: string; limit?: number }): Promise<GraphNode[]>;
}

export const GRAPH_DEFAULT_NODE_LIMIT = 200;
export const GRAPH_DEFAULT_EDGE_LIMIT = 500;
