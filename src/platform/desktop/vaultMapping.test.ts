/**
 * R006 阶段 2（C2）：vaultMapping 纯映射测试——
 * 扫描条目 → Page/Tag/PageTag 的 id 派生、parentId 链接、同级 position、
 * 时间戳与不可达 Vault 的名称后缀。
 */
import { describe, expect, it } from "vitest";
import type { VaultScanEntry } from "../../../shared/ipc/contracts";
import {
  DESKTOP_TAG_COLOR,
  mapOpenedVaultToWorkspace,
  mapRecentVaultToWorkspace,
  mapScanEntriesToPages,
  mapScanEntriesToTags,
} from "./vaultMapping";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";

const ENTRIES: VaultScanEntry[] = [
  {
    noteId: null,
    relativePath: "学习",
    kind: "group",
    title: "学习",
    parentPath: null,
    tags: [],
  },
  {
    noteId: "01JABC",
    relativePath: "学习/React.md",
    kind: "document",
    title: "React 笔记",
    parentPath: "学习",
    tags: ["前端"],
  },
  {
    noteId: null,
    relativePath: "学习/随笔.md",
    kind: "document",
    title: "随笔",
    parentPath: "学习",
    tags: ["前端", "随笔"],
  },
  {
    noteId: null,
    relativePath: "README.md",
    kind: "document",
    title: "README",
    parentPath: null,
    tags: [],
  },
];

describe("mapScanEntriesToPages", () => {
  const pages = mapScanEntriesToPages("vault-1", ENTRIES, 1000);

  it("id 派生：document 优先 noteId，缺失与 group 用 path: 前缀", () => {
    expect(pages.map((p) => p.id)).toEqual([
      "path:学习",
      "01JABC",
      "path:学习/随笔.md",
      "path:README.md",
    ]);
  });

  it("parentId 由 parentPath 映射，根级为 null", () => {
    expect(pages[0].parentId).toBeNull();
    expect(pages[1].parentId).toBe("path:学习");
    expect(pages[2].parentId).toBe("path:学习");
    expect(pages[3].parentId).toBeNull();
  });

  it("position 为同级内按扫描顺序的序号", () => {
    expect(pages[0].position).toBe(0); // 根级第 1 个
    expect(pages[1].position).toBe(0); // 「学习」内第 1 个
    expect(pages[2].position).toBe(1);
    expect(pages[3].position).toBe(1); // 根级第 2 个
  });

  it("kind/title/workspaceId/时间戳等字段完整", () => {
    expect(pages[0].kind).toBe("group");
    expect(pages[1].kind).toBe("document");
    expect(pages[1].title).toBe("React 笔记");
    for (const page of pages) {
      expect(page.workspaceId).toBe("vault-1");
      expect(page.createdAt).toBe(1000);
      expect(page.updatedAt).toBe(1000);
      expect(page.deletedAt).toBeNull();
      expect(page.favoriteAt).toBeNull();
      expect(page.lastOpenedAt).toBeNull();
    }
  });
});

describe("mapScanEntriesToTags", () => {
  it("标签按名称去重聚合，pageTags 与页面 id 一致", () => {
    const { tags, pageTags } = mapScanEntriesToTags("vault-1", ENTRIES);
    expect(tags).toEqual([
      {
        id: "tag:前端",
        workspaceId: "vault-1",
        name: "前端",
        color: DESKTOP_TAG_COLOR,
      },
      {
        id: "tag:随笔",
        workspaceId: "vault-1",
        name: "随笔",
        color: DESKTOP_TAG_COLOR,
      },
    ]);
    expect(pageTags).toEqual([
      { pageId: "01JABC", tagId: "tag:前端", workspaceId: "vault-1" },
      {
        pageId: "path:学习/随笔.md",
        tagId: "tag:前端",
        workspaceId: "vault-1",
      },
      {
        pageId: "path:学习/随笔.md",
        tagId: "tag:随笔",
        workspaceId: "vault-1",
      },
    ]);
  });

  it("Alias 存在时 pageTags.pageId 跟随 sessionPageId", () => {
    const aliases = new DesktopIdentityAliasRegistry();
    aliases.register({
      vaultId: "vault-1",
      sessionPageId: "path:学习/React.md",
      stableNoteId: "01JABC",
      relativePath: "学习/React.md",
    });
    const pages = mapScanEntriesToPages("vault-1", ENTRIES, 1000, aliases);
    expect(pages.find((p) => p.title === "React 笔记")?.id).toBe(
      "path:学习/React.md",
    );
    const { pageTags } = mapScanEntriesToTags("vault-1", ENTRIES, aliases);
    expect(pageTags.some((t) => t.pageId === "path:学习/React.md")).toBe(true);
    expect(pageTags.some((t) => t.pageId === "01JABC")).toBe(false);
  });
});

describe("mapRecentVaultToWorkspace", () => {
  it("正常条目映射（lastOpenedAt 解析为毫秒）", () => {
    const ws = mapRecentVaultToWorkspace({
      vaultId: "v1",
      absolutePath: "/tmp/a",
      displayName: "我的笔记",
      lastOpenedAt: "2026-08-09T10:00:00.000Z",
      accessible: true,
    });
    expect(ws.id).toBe("v1");
    expect(ws.name).toBe("我的笔记");
    expect(ws.lastOpenedAt).toBe(Date.parse("2026-08-09T10:00:00.000Z"));
    expect(ws.favoriteAt).toBeNull();
  });

  it("不可达条目保留并加名称后缀（重新定位属阶段 6）", () => {
    const ws = mapRecentVaultToWorkspace({
      vaultId: "v2",
      absolutePath: "/tmp/gone",
      displayName: "旧库",
      lastOpenedAt: "2026-08-01T00:00:00.000Z",
      accessible: false,
    });
    expect(ws.name).toBe("旧库（目录不可访问）");
  });
});

describe("mapOpenedVaultToWorkspace", () => {
  it("name 缺省时回退 displayName", () => {
    const ws = mapOpenedVaultToWorkspace(
      {
        vaultId: "v3",
        absolutePath: "/tmp/b",
        name: "",
        displayName: "目录名",
        createdAt: "2026-08-09T00:00:00.000Z",
        initialized: true,
      },
      2000,
    );
    expect(ws.name).toBe("目录名");
    expect(ws.lastOpenedAt).toBe(2000);
    expect(ws.createdAt).toBe(Date.parse("2026-08-09T00:00:00.000Z"));
  });
});
