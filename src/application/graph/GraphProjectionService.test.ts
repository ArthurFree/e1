/**
 * R015：GraphProjectionService 邻域投影与 orphan 定义。
 */
import { describe, expect, it } from "vitest";
import { buildExtractedLink } from "../../../shared/links/extractDocumentLinks";
import type { LinkIndexDocument } from "../links/LinkIndex";
import { InMemoryLinkIndex } from "../../infrastructure/memory/linkIndex";
import { GraphProjectionService, nodeFromPath } from "./GraphProjectionService";

function doc(
  id: string,
  relativePath: string,
  title: string,
  hrefs: string[],
): LinkIndexDocument {
  return {
    noteKey: id,
    vaultId: "v1",
    stableNoteId: id,
    relativePath,
    title,
    versionToken: "tok-1",
    links: hrefs
      .map((href) => buildExtractedLink(href, href, relativePath))
      .filter((l): l is NonNullable<typeof l> => l != null),
  };
}

describe("GraphProjectionService", () => {
  async function setup() {
    const index = new InMemoryLinkIndex();
    const a = doc("id-a", "a.md", "甲", ["b.md", "missing.md"]);
    const b = doc("id-b", "b.md", "乙", []);
    const c = doc("id-c", "c.md", "丙", []);
    await index.rebuild("v1", [a, b, c]);
    const catalog = [
      nodeFromPath("id-a", "甲", "notes/a.md", ["前端"]),
      nodeFromPath("id-b", "乙", "notes/b.md", ["前端"]),
      nodeFromPath("id-c", "丙", "c.md"),
    ];
    const graph = new GraphProjectionService(index, {
      async getNode(_vaultId, pageId) {
        return catalog.find((n) => n.id === pageId) ?? null;
      },
      async listDocumentNodes() {
        return catalog;
      },
    });
    return { graph };
  }

  it("GRAPH-02/08：Local Graph 以 stable id 为节点，broken 不虚构目标节点", async () => {
    const { graph } = await setup();
    const local = await graph.getLocalGraph({
      vaultId: "v1",
      pageId: "id-a",
      depth: 1,
      nodeLimit: 50,
      edgeLimit: 50,
      includeBroken: true,
    });
    expect(local.centerNodeId).toBe("id-a");
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["id-a", "id-b"]);
    const broken = local.edges.find((e) => e.state === "broken");
    expect(broken?.targetId).toBeNull();
    expect(broken?.href).toContain("missing.md");
    expect(local.nodes.some((n) => n.id.includes("missing"))).toBe(false);
  });

  it("depth 2 扩展邻居，且受 nodeLimit 截断", async () => {
    const { graph } = await setup();
    const local = await graph.getLocalGraph({
      vaultId: "v1",
      pageId: "id-a",
      depth: 2,
      nodeLimit: 1,
      edgeLimit: 50,
      includeBroken: false,
    });
    expect(local.nodes).toHaveLength(1);
    expect(local.truncated).toBe(true);
  });

  it("orphan：resolved in=0 且 resolved out=0", async () => {
    const { graph } = await setup();
    const orphans = await graph.getOrphans({ vaultId: "v1" });
    expect(orphans.map((n) => n.id)).toEqual(["id-c"]);
  });

  it("workspace graph 尊重 query / tag / groupPath 过滤", async () => {
    const { graph } = await setup();
    const byQuery = await graph.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 50,
      edgeLimit: 50,
      filters: { query: "乙" },
    });
    expect(byQuery.nodes.some((n) => n.id === "id-b")).toBe(true);
    expect(byQuery.nodes.some((n) => n.id === "id-c")).toBe(false);

    const byTag = await graph.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 50,
      edgeLimit: 50,
      filters: { tag: "前端" },
    });
    expect(byTag.nodes.every((n) => n.tags.includes("前端"))).toBe(true);

    const byGroup = await graph.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 50,
      edgeLimit: 50,
      filters: { groupPath: "notes" },
    });
    expect(byGroup.nodes.every((n) => n.groupPath === "notes")).toBe(true);
  });
});
