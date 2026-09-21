/**
 * R015.1：有界图谱画布布局（无第三方力导向库）。
 */
import type {
  GraphEdge,
  GraphNode,
  GraphProjection,
} from "../../application/graph/GraphQueryPort";

export type GraphHop = 0 | 1 | 2;
export type GraphNodeRole = "center" | "incoming" | "outgoing" | "hop2";

export interface LaidOutNode {
  id: string;
  title: string;
  x: number;
  y: number;
  hop: GraphHop;
  role: GraphNodeRole;
}

export interface LaidOutEdge {
  id: string;
  sourceId: string;
  targetId: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  state: GraphEdge["state"];
  href: string;
  broken: boolean;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

function hopOf(
  centerId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, GraphHop> {
  const hops = new Map<string, GraphHop>();
  hops.set(centerId, 0);
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.targetId) continue;
    const a = adj.get(edge.sourceId) ?? [];
    a.push(edge.targetId);
    adj.set(edge.sourceId, a);
    const b = adj.get(edge.targetId) ?? [];
    b.push(edge.sourceId);
    adj.set(edge.targetId, b);
  }
  const queue: Array<{ id: string; hop: GraphHop }> = [
    { id: centerId, hop: 0 },
  ];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur.id) ?? []) {
      if (hops.has(next)) continue;
      const hop = Math.min(2, cur.hop + 1) as GraphHop;
      hops.set(next, hop);
      if (hop < 2) queue.push({ id: next, hop });
    }
  }
  for (const node of nodes) {
    if (!hops.has(node.id)) hops.set(node.id, 2);
  }
  return hops;
}

function roleOf(
  nodeId: string,
  centerId: string,
  hop: GraphHop,
  edges: GraphEdge[],
): GraphNodeRole {
  if (nodeId === centerId) return "center";
  if (hop === 2) return "hop2";
  const incoming = edges.some(
    (e) => e.targetId === centerId && e.sourceId === nodeId,
  );
  const outgoing = edges.some(
    (e) => e.sourceId === centerId && e.targetId === nodeId,
  );
  if (incoming && !outgoing) return "incoming";
  return "outgoing";
}

export function layoutLocalGraph(projection: GraphProjection): GraphLayout {
  const centerId = projection.centerNodeId ?? projection.nodes[0]?.id ?? "";
  const hops = hopOf(centerId, projection.nodes, projection.edges);
  const incoming: GraphNode[] = [];
  const outgoing: GraphNode[] = [];
  const hop2: GraphNode[] = [];
  let center: GraphNode | undefined;
  for (const node of projection.nodes) {
    const hop = hops.get(node.id) ?? 2;
    const role = roleOf(node.id, centerId, hop, projection.edges);
    if (role === "center") center = node;
    else if (role === "incoming") incoming.push(node);
    else if (role === "hop2") hop2.push(node);
    else outgoing.push(node);
  }

  const width = 640;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const placed = new Map<string, LaidOutNode>();
  const place = (
    node: GraphNode,
    x: number,
    y: number,
    hop: GraphHop,
    role: GraphNodeRole,
  ) => {
    placed.set(node.id, { id: node.id, title: node.title, x, y, hop, role });
  };
  if (center) place(center, cx, cy, 0, "center");
  incoming.forEach((node, i) => {
    const t = incoming.length === 1 ? 0.5 : i / (incoming.length - 1);
    place(node, 120, 60 + t * (height - 120), 1, "incoming");
  });
  outgoing.forEach((node, i) => {
    const t = outgoing.length === 1 ? 0.5 : i / (outgoing.length - 1);
    place(node, width - 120, 60 + t * (height - 120), 1, "outgoing");
  });
  hop2.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(hop2.length, 1) - Math.PI / 2;
    place(
      node,
      cx + Math.cos(angle) * 220,
      cy + Math.sin(angle) * 130,
      2,
      "hop2",
    );
  });

  const edges: LaidOutEdge[] = projection.edges.map((edge) => {
    const from = placed.get(edge.sourceId);
    const to = edge.targetId ? placed.get(edge.targetId) : undefined;
    return {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      x1: from?.x ?? cx,
      y1: from?.y ?? cy,
      x2: to?.x ?? (from ? from.x + 80 : cx + 80),
      y2: to?.y ?? (from ? from.y - 40 : cy - 40),
      state: edge.state,
      href: edge.href,
      broken: edge.state === "broken" || !edge.targetId,
    };
  });

  return { nodes: [...placed.values()], edges, width, height };
}

export function layoutWorkspaceGraph(projection: GraphProjection): GraphLayout {
  const width = 720;
  const height = 480;
  const cx = width / 2;
  const cy = height / 2;
  const count = Math.max(projection.nodes.length, 1);
  const radius = Math.min(width, height) / 2 - 48;
  const placed = new Map<string, LaidOutNode>();
  projection.nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    placed.set(node.id, {
      id: node.id,
      title: node.title,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      hop: 1,
      role: "outgoing",
    });
  });
  const edges: LaidOutEdge[] = projection.edges.map((edge) => {
    const from = placed.get(edge.sourceId);
    const to = edge.targetId ? placed.get(edge.targetId) : undefined;
    return {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      x1: from?.x ?? cx,
      y1: from?.y ?? cy,
      x2: to?.x ?? (from ? from.x + 40 : cx + 40),
      y2: to?.y ?? (from ? from.y - 40 : cy - 40),
      state: edge.state,
      href: edge.href,
      broken: edge.state === "broken" || !edge.targetId,
    };
  });
  return { nodes: [...placed.values()], edges, width, height };
}
