/**
 * R006 阶段 2（C2）：Desktop 仓储测试——mock E1DesktopAPI（不触碰
 * window.e1），验证读路径映射与缓存、写路径诚实失败（DomainError
 * NOT_IMPLEMENTED / CANCELLED）、偏好 localStorage 持久化与桩仓储形状。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../domain/errors";
import type {
  AssetStore,
  ContentRepository,
  DocumentWriteRepository,
  PageRepository,
  PreferencesRepository,
  RevisionRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import { DEFAULT_PREFERENCES } from "../../domain/types";
import type { E1DesktopAPI, VaultScanResult } from "./desktopApi";
import {
  DesktopContentRepository,
  DesktopPageRepository,
  DesktopTagRepository,
  DesktopVaultScanCache,
  DesktopWorkspaceRepository,
} from "./repositories";
import { DesktopPreferencesRepository } from "./preferencesRepository";
import {
  DesktopAssetStore,
  DesktopDocumentWriteRepository,
  DesktopRevisionRepository,
} from "./stubRepositories";

const SCAN: VaultScanResult = {
  vault: { vaultId: "v1", name: "我的笔记" },
  entries: [
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
  ],
};

/** 构造 mock 桌面桥；未指定的方法给兜底实现。 */
function mockApi(overrides: {
  listRecent?: E1DesktopAPI["vault"]["listRecent"];
  selectDirectory?: E1DesktopAPI["vault"]["selectDirectory"];
  open?: E1DesktopAPI["vault"]["open"];
  scan?: E1DesktopAPI["vault"]["scan"];
}): E1DesktopAPI {
  return {
    platform: "desktop",
    versions: {},
    vault: {
      selectDirectory: overrides.selectDirectory ?? vi.fn(async () => null),
      open:
        overrides.open ??
        vi.fn(async () => {
          throw new Error("unexpected open");
        }),
      listRecent: overrides.listRecent ?? vi.fn(async () => []),
      scan: overrides.scan ?? vi.fn(async () => SCAN),
    },
    note: {
      read: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
    },
    asset: {
      pick: vi.fn(),
      import: vi.fn(),
      resolveUrl: vi.fn(),
    },
  } as unknown as E1DesktopAPI;
}

describe("DesktopWorkspaceRepository", () => {
  it("list 映射最近 Vault 并记录路径；不可达条目加后缀", async () => {
    const api = mockApi({
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/a",
          displayName: "我的笔记",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
        {
          vaultId: "v2",
          absolutePath: "/tmp/gone",
          displayName: "旧库",
          lastOpenedAt: "2026-08-01T00:00:00.000Z",
          accessible: false,
        },
      ]),
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(api);
    const list = await repo.list();
    expect(list.map((w) => w.id)).toEqual(["v1", "v2"]);
    expect(list[0].name).toBe("我的笔记");
    expect(list[1].name).toBe("旧库（目录不可访问）");
  });

  it("create：取消选择目录抛 DomainError(CANCELLED)", async () => {
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      mockApi({ selectDirectory: vi.fn(async () => null) }),
    );
    await expect(repo.create("任意名")).rejects.toMatchObject({
      name: "DomainError",
      code: "CANCELLED",
    });
  });

  it("create：选中目录后 vault.open 初始化并返回映射的 Workspace", async () => {
    const open = vi.fn(async () => ({
      vaultId: "v9",
      absolutePath: "/tmp/new",
      name: "新库",
      displayName: "new",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: true,
    }));
    const api = mockApi({
      selectDirectory: vi.fn(async () => ({
        vaultId: null,
        absolutePath: "/tmp/new",
        displayName: "new",
      })),
      open,
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(api);
    const ws = await repo.create("被忽略的名字");
    expect(open).toHaveBeenCalledWith({ absolutePath: "/tmp/new" });
    expect(ws).toMatchObject({ id: "v9", name: "新库" });
  });

  it("rename/update/setFavorite 抛 NOT_IMPLEMENTED", async () => {
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      mockApi({}),
    );
    await expect(repo.rename("v1", "x")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.update("v1", { name: "x" })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.setFavorite("v1", 1)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("setLastOpened：已知路径经 vault.open 触碰注册表；未知 id no-op；失败只告警", async () => {
    const open = vi.fn(async () => ({
      vaultId: "v1",
      absolutePath: "/tmp/a",
      name: "我的笔记",
      displayName: "a",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: false,
    }));
    const api = mockApi({
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/a",
          displayName: "我的笔记",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
      ]),
      open,
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(api);
    await repo.list();
    await repo.setLastOpened("v1", Date.now());
    expect(open).toHaveBeenCalledWith({ absolutePath: "/tmp/a" });
    // 未知 id：no-op，不抛错也不再调 open。
    await repo.setLastOpened("unknown", Date.now());
    expect(open).toHaveBeenCalledTimes(1);
    // open 失败（目录中途被移走）：只告警不抛出。
    open.mockRejectedValueOnce(new Error("目录不可访问"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(repo.setLastOpened("v1", Date.now())).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("DesktopPageRepository", () => {
  it("listByWorkspace 映射扫描条目为页面树；扫描经缓存只调一次", async () => {
    const scan = vi.fn(async () => SCAN);
    const api = mockApi({ scan });
    const cache = new DesktopVaultScanCache(api);
    const pages: PageRepository = new DesktopPageRepository(api, cache);
    const tags: TagRepository = new DesktopTagRepository(cache);

    const list = await pages.listByWorkspace("v1");
    expect(list.map((p) => [p.id, p.parentId, p.position])).toEqual([
      ["path:学习", null, 0],
      ["01JABC", "path:学习", 0],
    ]);
    // 会话加载的页面/标签读取共享同一缓存快照。
    await tags.listByWorkspace("v1");
    await tags.listWorkspacePageTags("v1");
    await pages.listByWorkspace("v1");
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("listAll：逐可访问 Vault 扫描合并；失败库跳过并告警", async () => {
    const scan = vi.fn(async (vaultId: string) => {
      if (vaultId === "bad") throw new Error("扫描失败");
      return SCAN;
    });
    const api = mockApi({
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/a",
          displayName: "A",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
        {
          vaultId: "gone",
          absolutePath: "/tmp/g",
          displayName: "G",
          lastOpenedAt: "2026-08-09T09:00:00.000Z",
          accessible: false,
        },
        {
          vaultId: "bad",
          absolutePath: "/tmp/b",
          displayName: "B",
          lastOpenedAt: "2026-08-09T08:00:00.000Z",
          accessible: true,
        },
      ]),
      scan,
    });
    const repo: PageRepository = new DesktopPageRepository(
      api,
      new DesktopVaultScanCache(api),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const all = await repo.listAll();
    warn.mockRestore();
    // 可访问且扫描成功的只有 v1（gone 不可达跳过、bad 失败跳过）。
    expect(all.every((p) => p.workspaceId === "v1")).toBe(true);
    expect(all).toHaveLength(2);
    expect(scan).not.toHaveBeenCalledWith("gone");
  });

  it("写操作全部抛 DomainError(NOT_IMPLEMENTED) 且含中文文案", async () => {
    const api = mockApi({});
    const repo: PageRepository = new DesktopPageRepository(
      api,
      new DesktopVaultScanCache(api),
    );
    const cases: Array<() => Promise<unknown>> = [
      () =>
        repo.create({
          workspaceId: "v1",
          parentId: null,
          kind: "document",
          title: "x",
        }),
      () => repo.rename("p", "x"),
      () => repo.setFavorite("p", 1),
      () => repo.setLastOpened("p", 1),
      () => repo.move("p", null, 0),
      () => repo.remove("p"),
      () => repo.restore("p"),
      () => repo.purge("p"),
      () => repo.purgeTrashed("v1"),
    ];
    for (const run of cases) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("NOT_IMPLEMENTED");
      expect((err as DomainError).message).toMatch(/桌面端暂不支持/);
    }
  });
});

describe("DesktopContentRepository", () => {
  it("get/save 抛 NOT_IMPLEMENTED（阶段 3/4）；listAll/listByWorkspace 返回空", async () => {
    const repo: ContentRepository = new DesktopContentRepository();
    await expect(repo.get("p")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.save("p", {}, "", "")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.listAll()).resolves.toEqual([]);
    await expect(repo.listByWorkspace("v1")).resolves.toEqual([]);
  });
});

describe("DesktopTagRepository", () => {
  it("标签与关联从扫描条目聚合", async () => {
    const api = mockApi({});
    const repo: TagRepository = new DesktopTagRepository(
      new DesktopVaultScanCache(api),
    );
    expect(await repo.listByWorkspace("v1")).toEqual([
      expect.objectContaining({ id: "tag:前端", name: "前端" }),
    ]);
    expect(await repo.listWorkspacePageTags("v1")).toEqual([
      { pageId: "01JABC", tagId: "tag:前端", workspaceId: "v1" },
    ]);
  });

  it("listPageTagIds 按页面 id 反查；未知页面返回空", async () => {
    const api = mockApi({
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "我的笔记" },
        entries: [
          {
            noteId: "01JABC",
            relativePath: "a.md",
            kind: "document" as const,
            title: "A",
            parentPath: null,
            tags: ["前端"],
          },
          {
            noteId: null,
            relativePath: "b.md",
            kind: "document" as const,
            title: "B",
            parentPath: null,
            tags: ["随笔"],
          },
        ],
      })),
    });
    const cache = new DesktopVaultScanCache(api);
    const repo: TagRepository = new DesktopTagRepository(cache);
    await cache.scan("v1"); // 先建立缓存
    // noteId 与路径派生 id 都是各自条目的页面 id。
    expect(await repo.listPageTagIds("01JABC")).toEqual(["tag:前端"]);
    expect(await repo.listPageTagIds("path:b.md")).toEqual(["tag:随笔"]);
    expect(await repo.listPageTagIds("不存在的页面")).toEqual([]);
  });

  it("写操作抛 NOT_IMPLEMENTED", async () => {
    const repo: TagRepository = new DesktopTagRepository(
      new DesktopVaultScanCache(mockApi({})),
    );
    await expect(repo.create("v1", "t", "#000")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.remove("t")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.setPageTags("p", [])).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});

describe("桩仓储（阶段 3/4/5 前）", () => {
  it("RevisionRepository：列表空、写入抛错", async () => {
    const repo: RevisionRepository = new DesktopRevisionRepository();
    await expect(repo.listByPage("p")).resolves.toEqual([]);
    await expect(repo.add("p", {}, "", "manual")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.pruneInterval("p", 1)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("AssetStore：读取空、写入抛错", async () => {
    const store: AssetStore = new DesktopAssetStore();
    await expect(store.getMetadata("a")).resolves.toBeUndefined();
    await expect(store.getBinary("a")).resolves.toBeUndefined();
    await expect(store.listByDocument("p")).resolves.toEqual([]);
    await expect(
      store.add({
        pageId: "p",
        name: "a.png",
        mimeType: "image/png",
        size: 1,
        data: new Uint8Array(1),
      }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(store.remove("a")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(store.removeOrphans("p", [])).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("DocumentWriteRepository：原子写抛错", async () => {
    const repo: DocumentWriteRepository = new DesktopDocumentWriteRepository();
    await expect(
      repo.createWithContent({
        workspaceId: "v1",
        parentId: null,
        title: "x",
        contentJson: {},
        textSnapshot: "",
      }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(
      repo.replaceContent({ pageId: "p", contentJson: {}, textSnapshot: "" }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("DesktopPreferencesRepository", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("无记录回退默认偏好；update 合并并持久化", async () => {
    const repo: PreferencesRepository = new DesktopPreferencesRepository();
    expect(await repo.get()).toEqual(DEFAULT_PREFERENCES);
    const next = await repo.update({
      theme: "dark",
      lastRoute: '{"view":"start"}',
    });
    expect(next.theme).toBe("dark");
    // 新实例（模拟重启）能读到持久化结果。
    expect((await new DesktopPreferencesRepository().get()).lastRoute).toBe(
      '{"view":"start"}',
    );
  });

  it("损坏 JSON 回退默认偏好", async () => {
    localStorage.setItem("e1:desktop-preferences", "{not-json");
    const repo: PreferencesRepository = new DesktopPreferencesRepository();
    expect(await repo.get()).toEqual(DEFAULT_PREFERENCES);
  });
});
