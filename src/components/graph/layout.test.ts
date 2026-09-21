import { describe, expect, it } from "vitest";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import { layoutLocalGraph, layoutWorkspaceGraph } from "./layout";

function projection(): GraphProjection {
  return {
    centerNodeId: "a",
    truncated: false,
    nodes: [
      {
        id: "a",
        title: "中心",
        relativePath: "a.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "b",
        title: "出站",
        relativePath: "b.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "c",
        title: "来源",
        relativePath: "c.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "d",
        title: "二跳",
        relativePath: "d.md",
        groupPath: null,
        tags: [],
      },
    ],
    edges: [
      {
        id: "a-b",
        sourceId: "a",
        targetId: "b",
        direction: "outgoing",
        state: "resolved",
        href: "b.md",
      },
      {
        id: "c-a",
        sourceId: "c",
        targetId: "a",
        direction: "outgoing",
        state: "resolved",
        href: "a.md",
      },
      {
        id: "b-d",
        sourceId: "b",
        targetId: "d",
        direction: "outgoing",
        state: "resolved",
        href: "d.md",
      },
    ],
  };
}

describe("layoutLocalGraph", () => {
  it("区分 center / incoming / outgoing / hop2", () => {
    const layout = layoutLocalGraph(projection());
    expect(layout.nodes.find((n) => n.id === "a")?.role).toBe("center");
    expect(layout.nodes.find((n) => n.id === "b")?.role).toBe("outgoing");
    expect(layout.nodes.find((n) => n.id === "c")?.role).toBe("incoming");
    expect(layout.nodes.find((n) => n.id === "d")?.role).toBe("hop2");
    const incoming = layout.nodes.find((n) => n.id === "c")!;
    const outgoing = layout.nodes.find((n) => n.id === "b")!;
    expect(incoming.x).toBeLessThan(outgoing.x);
  });
});

describe("layoutWorkspaceGraph", () => {
  it("为每个节点分配坐标", () => {
    const layout = layoutWorkspaceGraph(projection());
    expect(layout.nodes).toHaveLength(4);
    expect(new Set(layout.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(4);
  });
});
