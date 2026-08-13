/**
 * R006 阶段 2（C2）：createDesktopRuntime 测试——真实 IPC-backed 装配：
 * 容器字段完整、capabilities 为桌面矩阵；mock E1DesktopAPI 验证
 * 读路径（listWorkspaces / loadSession / 标题搜索）真实走 IPC、
 * 写路径经命令服务诚实失败（DomainError）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopRuntime } from "./createDesktopRuntime";
import { desktopCapabilities } from "./desktopCapabilities";
import type { E1DesktopAPI } from "./desktopApi";

const SCAN = {
  vault: { vaultId: "v1", name: "我的笔记" },
  entries: [
    {
      noteId: null,
      relativePath: "学习",
      kind: "group" as const,
      title: "学习",
      parentPath: null,
      tags: [],
    },
    {
      noteId: "01JABC",
      relativePath: "学习/React.md",
      kind: "document" as const,
      title: "React 笔记",
      parentPath: "学习",
      tags: ["前端"],
    },
  ],
};

function mockApi(
  overrides: Partial<{
    selectDirectory: E1DesktopAPI["vault"]["selectDirectory"];
  }> = {},
): E1DesktopAPI {
  return {
    platform: "desktop",
    versions: {},
    vault: {
      selectDirectory: overrides.selectDirectory ?? vi.fn(async () => null),
      open: vi.fn(async () => {
        throw new Error("unexpected open");
      }),
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/a",
          displayName: "我的笔记",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
      ]),
      scan: vi.fn(async () => SCAN),
    },
    note: { read: vi.fn(), create: vi.fn(), save: vi.fn() },
    asset: {
      pick: vi.fn(),
      import: vi.fn(),
      read: vi.fn(),
      resolveUrl: vi.fn(),
    },
  } as unknown as E1DesktopAPI;
}

describe("createDesktopRuntime（IPC-backed）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("capabilities 为桌面能力矩阵（runtime 与 services 两处一致）", () => {
    const runtime = createDesktopRuntime(mockApi());
    expect(runtime.capabilities).toBe(desktopCapabilities);
    expect(runtime.services.capabilities).toBe(desktopCapabilities);
  });

  it("返回完整 AppServices 形状", () => {
    const { services } = createDesktopRuntime(mockApi());
    expect(Object.keys(services.commands).sort()).toEqual([
      "document",
      "page",
      "tag",
      "workspace",
    ]);
    expect(Object.keys(services.queries).sort()).toEqual([
      "document",
      "search",
      "workspace",
    ]);
    for (const key of [
      "assets",
      "preferencesService",
      "secretStore",
      "aiConfigService",
      "recoveryStore",
      "syncChannel",
      "storageHealth",
      "createAIProvider",
      "createSaveCoordinator",
    ] as const) {
      expect(services[key], `缺少 ${key}`).toBeDefined();
    }
  });

  it("listWorkspaces 经 vault:listRecent 映射", async () => {
    const { services } = createDesktopRuntime(mockApi());
    const workspaces = await services.queries.workspace.listWorkspaces();
    expect(workspaces.map((w) => [w.id, w.name])).toEqual([["v1", "我的笔记"]]);
  });

  it("loadSession 经 vault:scan 映射页面树与标签；搜索索引含标题", async () => {
    const { services } = createDesktopRuntime(mockApi());
    const data = await services.queries.workspace.loadSession("v1");
    expect(data.pages.map((p) => [p.id, p.parentId])).toEqual([
      ["path:学习", null],
      ["01JABC", "path:学习"],
    ]);
    expect(data.tags.map((t) => t.name)).toEqual(["前端"]);
    expect(data.pageTags).toEqual([
      { pageId: "01JABC", tagId: "tag:前端", workspaceId: "v1" },
    ]);
    // 正文仓储恒空：索引只有标题元数据，标题搜索可用。
    const hits = await services.queries.search.query("v1", data.pages, "React");
    expect(hits.map((h) => h.pageId)).toEqual(["01JABC"]);
  });

  it("写路径：page.create / document.createWithContent 接通 note.create；未扫描正文仍 PAGE_NOT_FOUND", async () => {
    const api = mockApi();
    (api.note as unknown as { create: ReturnType<typeof vi.fn> }).create =
      vi.fn(async () => ({
        noteId: "01NEW",
        relativePath: "x.md",
        versionToken: `sha256:${"a".repeat(64)}`,
      }));
    // 创建后扫描需能返回新页面。
    let created = false;
    (api.vault.scan as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        vault: { vaultId: "v1", name: "我的笔记" },
        entries: created
          ? [
              {
                noteId: "01NEW",
                relativePath: "x.md",
                kind: "document" as const,
                title: "x",
                parentPath: null,
                tags: [],
              },
            ]
          : [],
      }),
    );
    const { services } = createDesktopRuntime(api);
    created = true;
    const page = await services.commands.page.create({
      workspaceId: "v1",
      parentId: null,
      kind: "document",
      title: "x",
    });
    expect(page.id).toBe("01NEW");
    expect(api.note.create).toHaveBeenCalled();
    // getContent 未经打开：扫描有条目但 note.read 未 mock → 需 mock read。
    await expect(
      services.queries.document.getContent("missing"),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });
  it("workspace.create：取消目录选择抛 DomainError(CANCELLED)", async () => {
    const { services } = createDesktopRuntime(
      mockApi({ selectDirectory: vi.fn(async () => null) }),
    );
    await expect(services.commands.workspace.create("x")).rejects.toMatchObject(
      { name: "DomainError", code: "CANCELLED" },
    );
  });

  it("vaultMaintenance.rescan：扫描缓存失效并重新扫描（FR-26）", async () => {
    const api = mockApi();
    const { services } = createDesktopRuntime(api);
    expect(services.vaultMaintenance).toBeDefined();
    // 会话加载建立缓存快照（扫描一次）。
    await services.queries.workspace.loadSession("v1");
    expect(api.vault.scan).toHaveBeenCalledTimes(1);
    // 重新扫描：缓存失效 + 新快照预热。
    await services.vaultMaintenance!.rescan("v1");
    expect(api.vault.scan).toHaveBeenCalledTimes(2);
    // 预热快照被后续页面刷新复用，不触发第三次扫描。
    await services.queries.workspace.loadPages("v1");
    expect(api.vault.scan).toHaveBeenCalledTimes(2);
  });

  it("documentSafety：三个会话级批准门闸齐备（PR5）", () => {
    const { services } = createDesktopRuntime(mockApi());
    expect(Object.keys(services.documentSafety ?? {}).sort()).toEqual([
      "approveIdentityAdoption",
      "approveLossyOutput",
      "approveLossySource",
    ]);
  });
});
