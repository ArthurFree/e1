import { describe, expect, it } from "vitest";
import type { Page } from "./types";
import { buildPickerTargets } from "./picker";

function makePage(partial: Partial<Page> & { id: string }): Page {
  return {
    workspaceId: "ws1",
    parentId: null,
    kind: "document",
    title: partial.id,
    icon: null,
    position: 0,
    favoriteAt: null,
    lastOpenedAt: null,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("buildPickerTargets", () => {
  it("列出知识库根目录与树序分组，排除文档与回收站", () => {
    const workspaces = [
      { id: "ws1", name: "库一", icon: null },
      { id: "ws2", name: "库二", icon: "🛠️" },
    ];
    const pages = [
      makePage({ id: "g1", kind: "group", title: "产品", position: 0 }),
      makePage({ id: "g2", kind: "group", title: "子分组", parentId: "g1", position: 0 }),
      makePage({ id: "d1", parentId: "g1" }),
      makePage({ id: "g3", kind: "group", title: "已删", deletedAt: 1, position: 1 }),
      makePage({ id: "g4", kind: "group", title: "库二组", workspaceId: "ws2", position: 0 }),
    ];
    const targets = buildPickerTargets(workspaces, pages);
    expect(targets.map((t) => [t.workspaceId, t.parentId, t.depth])).toEqual([
      ["ws1", null, 0],
      ["ws1", "g1", 1],
      ["ws1", "g2", 2],
      ["ws2", null, 0],
      ["ws2", "g4", 1],
    ]);
    expect(targets[0].label).toBe("📚 库一");
    expect(targets[3].label).toBe("🛠️ 库二");
  });
});
