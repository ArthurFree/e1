/**
 * R015.1：DesktopGraphQuery 的 Tag 筛选翻译——Renderer 侧经扫描快照把
 * tag 翻成 noteKeys 后必须移除 tag 字段（Main 投影没有 tagsById，
 * 节点 tags 恒为 []，保留 tag 会把所有节点滤掉）。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  GraphFilters,
  GraphProjection,
} from "../../application/graph/GraphQueryPort";
import type { LinkIndex } from "../../application/links/LinkIndex";
import { createDesktopGraphQuery } from "./DesktopGraphQuery";
import type { E1DesktopAPI, VaultScanEntry } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

const EMPTY_PROJECTION: GraphProjection = {
  nodes: [],
  edges: [],
  truncated: false,
};

function entry(partial: Partial<VaultScanEntry>): VaultScanEntry {
  return {
    noteId: null,
    relativePath: "笔记.md",
    kind: "document",
    title: "笔记",
    parentPath: null,
    tags: [],
    ...partial,
  };
}

function makePort(entries: VaultScanEntry[]) {
  const workspace = vi.fn(
    async (req: {
      vaultId: string;
      nodeLimit: number;
      edgeLimit: number;
      filters?: GraphFilters;
    }): Promise<GraphProjection> => {
      void req;
      return EMPTY_PROJECTION;
    },
  );
  const api = {
    graph: { workspace, neighborhood: vi.fn(), orphans: vi.fn() },
  } as unknown as E1DesktopAPI;
  const linkIndex = {
    prepare: vi.fn(async () => undefined),
  } as unknown as LinkIndex;
  const scans = {
    scan: vi.fn(async () => ({
      result: { vault: { vaultId: "v1", name: "库" }, entries },
      scannedAt: 0,
    })),
    aliases: {
      getBySessionPageId: () => undefined,
      getByStableNoteId: () => undefined,
      getByRelativePath: () => undefined,
    },
  } as unknown as DesktopVaultScanCache;
  return { port: createDesktopGraphQuery(api, linkIndex, scans), workspace };
}

describe("DesktopGraphQuery Tag 筛选翻译", () => {
  it("tag 翻成 noteKeys 后不再携带 tag 字段", async () => {
    const { port, workspace } = makePort([
      entry({ noteId: "n1", relativePath: "a.md", tags: ["数学"] }),
      entry({ noteId: "n2", relativePath: "b.md", tags: ["语文"] }),
    ]);
    await port.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 200,
      edgeLimit: 500,
      filters: { tag: "数学" },
    });
    const filters = workspace.mock.calls[0]?.[0]?.filters as Record<
      string,
      unknown
    >;
    expect(filters.noteKeys).toEqual(["n1"]);
    expect("tag" in filters).toBe(false);
  });

  it("无匹配 tag 时注入哨兵 noteKeys，Main 侧得到空图", async () => {
    const { port, workspace } = makePort([
      entry({ noteId: "n1", relativePath: "a.md", tags: ["数学"] }),
    ]);
    await port.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 200,
      edgeLimit: 500,
      filters: { tag: "不存在" },
    });
    const filters = workspace.mock.calls[0]?.[0]?.filters as Record<
      string,
      unknown
    >;
    expect(filters.noteKeys).toEqual(["__no_match__"]);
    expect("tag" in filters).toBe(false);
  });

  it("tag 与 groupPath 组合时保留 groupPath", async () => {
    const { port, workspace } = makePort([
      entry({
        noteId: "n1",
        relativePath: "学习/a.md",
        parentPath: "学习",
        tags: ["数学"],
      }),
    ]);
    await port.getWorkspaceGraph({
      vaultId: "v1",
      nodeLimit: 200,
      edgeLimit: 500,
      filters: { tag: "数学", groupPath: "学习" },
    });
    const filters = workspace.mock.calls[0]?.[0]?.filters as Record<
      string,
      unknown
    >;
    expect(filters).toEqual({ groupPath: "学习", noteKeys: ["n1"] });
  });
});
