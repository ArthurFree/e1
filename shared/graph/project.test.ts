import { describe, expect, it } from "vitest";
import {
  projectLocalGraph,
  projectOrphans,
  projectWorkspaceGraph,
} from "./project.js";

const docs = [
  { noteKey: "a", title: "甲", relativePath: "notes/a.md" },
  { noteKey: "b", title: "乙", relativePath: "notes/b.md" },
  { noteKey: "c", title: "丙", relativePath: "c.md" },
  { noteKey: "d", title: "丁", relativePath: "other/d.md" },
];

const links = [
  {
    sourceNoteKey: "a",
    targetNoteKey: "b",
    href: "b.md",
    label: "乙",
    broken: false,
  },
  {
    sourceNoteKey: "b",
    targetNoteKey: "c",
    href: "../c.md",
    label: "丙",
    broken: false,
  },
  {
    sourceNoteKey: "a",
    targetNoteKey: null,
    href: "missing.md",
    label: "缺失",
    broken: true,
  },
];

const tagsById = new Map<string, string[]>([
  ["a", ["前端"]],
  ["b", ["前端"]],
  ["c", []],
  ["d", ["随笔"]],
]);

describe("projectLocalGraph", () => {
  it("depth=1 只含直连，broken 不虚构节点", () => {
    const local = projectLocalGraph({
      centerId: "a",
      depth: 1,
      docs,
      links,
      includeBroken: true,
      tagsById,
    });
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(
      local.edges.some((e) => e.state === "broken" && e.targetId === null),
    ).toBe(true);
    expect(local.nodes.find((n) => n.id === "a")?.tags).toEqual(["前端"]);
    expect(local.nodes.find((n) => n.id === "a")?.groupPath).toBe("notes");
  });

  it("depth=2 展开第二跳", () => {
    const local = projectLocalGraph({
      centerId: "a",
      depth: 2,
      docs,
      links,
      includeBroken: false,
      tagsById,
    });
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("nodeLimit 截断", () => {
    const local = projectLocalGraph({
      centerId: "a",
      depth: 2,
      docs,
      links,
      nodeLimit: 1,
      includeBroken: false,
    });
    expect(local.nodes).toHaveLength(1);
    expect(local.truncated).toBe(true);
  });
});

describe("projectWorkspaceGraph", () => {
  it("query / group / tag / orphan 过滤", () => {
    const orphans = projectOrphans({ docs, links, tagsById });
    expect(orphans.map((n) => n.id)).toEqual(["d"]);

    const byTag = projectWorkspaceGraph({
      docs,
      links,
      tagsById,
      orphanIds: new Set(["d"]),
      filters: { tag: "随笔" },
    });
    expect(byTag.nodes.map((n) => n.id)).toEqual(["d"]);

    const byGroup = projectWorkspaceGraph({
      docs,
      links,
      tagsById,
      filters: { groupPath: "notes" },
    });
    expect(byGroup.nodes.some((n) => n.id === "a")).toBe(true);
    expect(byGroup.nodes.some((n) => n.id === "b")).toBe(true);
    expect(byGroup.nodes.some((n) => n.id === "d")).toBe(false);

    const byQuery = projectWorkspaceGraph({
      docs,
      links,
      tagsById,
      filters: { query: "丙" },
    });
    expect(byQuery.nodes.some((n) => n.id === "c")).toBe(true);
    expect(byQuery.nodes.some((n) => n.id === "d")).toBe(false);

    const onlyOrphans = projectWorkspaceGraph({
      docs,
      links,
      tagsById,
      orphanIds: new Set(["d"]),
      filters: { orphansOnly: true },
    });
    expect(onlyOrphans.nodes.map((n) => n.id)).toEqual(["d"]);
  });

  it("nodeLimit 截断并标记 truncated", () => {
    const result = projectWorkspaceGraph({
      docs,
      links,
      tagsById,
      nodeLimit: 1,
    });
    expect(result.nodes.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });
});
