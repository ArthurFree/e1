/**
 * R006 阶段 2（C2）：Desktop 仓储测试——mock E1DesktopAPI（不触碰
 * window.e1），验证读路径映射与缓存、写路径诚实失败（DomainError
 * NOT_IMPLEMENTED / CANCELLED）、偏好 localStorage 持久化与桩仓储形状。
 * R006-C2.1：create 两段式（openRecent / VAULT_CONFIRMATION_REQUIRED 挂起 /
 * openSelection 初始化与 transient 仅预览）、transient 合并进 list、
 * setLastOpened 走 openRecent。
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
import type {
  E1DesktopAPI,
  IpcErrorCode,
  ReadNoteResult,
  VaultScanResult,
} from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import {
  createEmptyVaultState,
  type PatchVaultStateInput,
} from "../../../shared/ipc/contracts";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import {
  decidePendingVaultSelection,
  discardPendingVaultSelection,
  peekPendingVaultSelection,
} from "./vaultOpenConfirmation";
import {
  DesktopContentRepository,
  DesktopDocumentWriteRepository,
  DesktopPageRepository,
  DesktopTagRepository,
  DesktopVaultScanCache,
  DesktopWorkspaceRepository,
} from "./repositories";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { DesktopNoteMetadataService } from "./DesktopNoteMetadataService";
import { DesktopVaultStateClient } from "./DesktopVaultStateClient";
import { createInMemoryDocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import { DesktopPreferencesRepository } from "./preferencesRepository";
import { DesktopRevisionRepository } from "./stubRepositories";
import { DesktopAssetStore } from "./DesktopAssetStore";
import { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import { deterministicTagColor } from "./vaultMapping";

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

/** 构造 mock 桌面桥（R009 Stage 0.3：统一工厂）；未指定的方法用工厂默认。 */
function mockApi(overrides: {
  listRecent?: E1DesktopAPI["vault"]["listRecent"];
  selectDirectory?: E1DesktopAPI["vault"]["selectDirectory"];
  openRecent?: E1DesktopAPI["vault"]["openRecent"];
  openSelection?: E1DesktopAPI["vault"]["openSelection"];
  scan?: E1DesktopAPI["vault"]["scan"];
  createDirectory?: E1DesktopAPI["vault"]["createDirectory"];
  trash?: E1DesktopAPI["vault"]["trash"];
  listTrash?: E1DesktopAPI["vault"]["listTrash"];
  restore?: E1DesktopAPI["vault"]["restore"];
  purgeTrash?: E1DesktopAPI["vault"]["purgeTrash"];
  noteRead?: E1DesktopAPI["note"]["read"];
  noteMove?: E1DesktopAPI["note"]["move"];
  notePatchMetadata?: E1DesktopAPI["note"]["patchMetadata"];
  vaultStateGet?: E1DesktopAPI["vaultState"]["get"];
  vaultStatePatch?: E1DesktopAPI["vaultState"]["patch"];
}): E1DesktopAPI {
  return createMockDesktopApi({
    vault: {
      selectDirectory: overrides.selectDirectory,
      openRecent:
        overrides.openRecent ??
        vi.fn(async () => {
          throw new Error("unexpected openRecent");
        }),
      openSelection:
        overrides.openSelection ??
        vi.fn(async () => {
          throw new Error("unexpected openSelection");
        }),
      listRecent: overrides.listRecent,
      scan: overrides.scan ?? vi.fn(async () => SCAN),
      createDirectory: overrides.createDirectory,
      trash: overrides.trash,
      listTrash: overrides.listTrash,
      restore: overrides.restore,
      purgeTrash: overrides.purgeTrash,
    },
    vaultState: {
      get: overrides.vaultStateGet,
      patch: overrides.vaultStatePatch,
    },
    note: {
      read: overrides.noteRead,
      patchMetadata: overrides.notePatchMetadata,
      move: overrides.noteMove,
    },
  });
}

/** R007 阶段 2：交互状态客户端的测试装配（与生产同一实例语义）。 */
function stateClient(api: E1DesktopAPI): DesktopVaultStateClient {
  return new DesktopVaultStateClient(api);
}

/** R007 阶段 1：元数据写入服务 + 版本通道的测试装配。 */
function metadataService(
  api: E1DesktopAPI,
  scans: DesktopVaultScanCache,
  sources = new DesktopDocumentSourceCache(),
  versions = createInMemoryDocumentVersionChannel(),
) {
  const service = new DesktopNoteMetadataService(api, scans, sources, versions);
  return { service, sources, versions };
}

describe("DesktopWorkspaceRepository", () => {
  beforeEach(() => {
    // 确认握手模块为进程级单例，逐用例清理避免串扰。
    discardPendingVaultSelection();
  });

  it("list 映射最近 Vault；不可达条目加后缀", async () => {
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
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    const list = await repo.list();
    expect(list.map((w) => w.id)).toEqual(["v1", "v2"]);
    expect(list[0].name).toBe("我的笔记");
    expect(list[1].name).toBe("旧库（目录不可访问）");
  });

  it("create：取消选择目录抛 DomainError(CANCELLED)", async () => {
    const api = mockApi({ selectDirectory: vi.fn(async () => null) });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await expect(repo.create("任意名")).rejects.toMatchObject({
      name: "DomainError",
      code: "CANCELLED",
    });
  });

  it("create：已初始化目录经 vault.openRecent 打开并返回映射的 Workspace", async () => {
    const openRecent = vi.fn(async () => ({
      vaultId: "v9",
      absolutePath: "/tmp/known",
      name: "已知库",
      displayName: "known",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: false,
    }));
    const api = mockApi({
      selectDirectory: vi.fn(async () => ({
        selectionToken: "s-token",
        vaultId: "v9",
        displayName: "known",
        initialized: true,
      })),
      openRecent,
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    const ws = await repo.create("被忽略的名字");
    expect(openRecent).toHaveBeenCalledWith({ vaultId: "v9" });
    expect(ws).toMatchObject({ id: "v9", name: "已知库" });
  });

  it("create：未初始化目录抛 VAULT_CONFIRMATION_REQUIRED 并挂起令牌（FR-03）", async () => {
    const api = mockApi({
      selectDirectory: vi.fn(async () => ({
        selectionToken: "s-token",
        vaultId: null,
        displayName: "普通文件夹",
        initialized: false,
      })),
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await expect(repo.create("任意名")).rejects.toMatchObject({
      name: "DomainError",
      code: "VAULT_CONFIRMATION_REQUIRED",
    });
    expect(peekPendingVaultSelection()).toEqual({
      selectionToken: "s-token",
      displayName: "普通文件夹",
    });
  });

  it("create：确认「初始化并打开」后重进 —— openSelection(initialize=true)", async () => {
    const openSelection = vi.fn(async () => ({
      vaultId: "v-new",
      absolutePath: "/tmp/new",
      name: "新库",
      displayName: "new",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: true,
    }));
    const api = mockApi({
      selectDirectory: vi.fn(async () => ({
        selectionToken: "s-token",
        vaultId: null,
        displayName: "new",
        initialized: false,
      })),
      openSelection,
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await expect(repo.create("任意名")).rejects.toMatchObject({
      code: "VAULT_CONFIRMATION_REQUIRED",
    });
    decidePendingVaultSelection(true);
    const ws = await repo.create("任意名");
    expect(openSelection).toHaveBeenCalledWith({
      selectionToken: "s-token",
      initialize: true,
    });
    expect(ws).toMatchObject({ id: "v-new", name: "新库" });
  });

  it("create：「仅预览」产生 transient 知识库（（预览）后缀）并并入 list", async () => {
    const openSelection = vi.fn(async () => ({
      vaultId: "transient:t-1",
      absolutePath: "/tmp/plain",
      name: "plain",
      displayName: "plain",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: false,
      transient: true,
    }));
    const api = mockApi({
      selectDirectory: vi.fn(async () => ({
        selectionToken: "s-token",
        vaultId: null,
        displayName: "plain",
        initialized: false,
      })),
      openSelection,
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/a",
          displayName: "常规库",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
      ]),
    });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await expect(repo.create("任意名")).rejects.toMatchObject({
      code: "VAULT_CONFIRMATION_REQUIRED",
    });
    decidePendingVaultSelection(false);
    const ws = await repo.create("任意名");
    expect(openSelection).toHaveBeenCalledWith({
      selectionToken: "s-token",
      initialize: false,
    });
    expect(ws).toMatchObject({ id: "transient:t-1", name: "plain（预览）" });
    // list 合并注册表 recents 与会话内 transient。
    const list = await repo.list();
    expect(list.map((w) => w.id)).toEqual(["v1", "transient:t-1"]);
    expect(list[1].name).toBe("plain（预览）");
    // transient 的 setLastOpened 为 no-op（不进注册表）。
    await repo.setLastOpened("transient:t-1", Date.now());
  });

  it("rename 走 vault.rename；update 仍 NOT_IMPLEMENTED", async () => {
    const api = mockApi({});
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await repo.rename("v1", "新名称");
    expect(api.vault.rename).toHaveBeenCalledWith({
      vaultId: "v1",
      name: "新名称",
    });
    await expect(repo.update("v1", { name: "x" })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("setLastOpened：经 vault.openRecent 触碰注册表；失败只告警不抛出", async () => {
    const openRecent = vi.fn(async () => ({
      vaultId: "v1",
      absolutePath: "/tmp/a",
      name: "我的笔记",
      displayName: "a",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: false,
    }));
    const api = mockApi({ openRecent });
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      stateClient(api),
    );
    await repo.setLastOpened("v1", Date.now());
    expect(openRecent).toHaveBeenCalledWith({ vaultId: "v1" });
    // openRecent 失败（目录中途被移走）：只告警不抛出。
    openRecent.mockRejectedValueOnce(new Error("目录不可访问"));
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
    const pages: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );
    const tags: TagRepository = new DesktopTagRepository(
      cache,
      metadataService(api, cache).service,
    );

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
      metadataService(api, new DesktopVaultScanCache(api)).service,
      stateClient(api),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const all = await repo.listAll();
    warn.mockRestore();
    // 可访问且扫描成功的只有 v1（gone 不可达跳过、bad 失败跳过）。
    expect(all.every((p) => p.workspaceId === "v1")).toBe(true);
    expect(all).toHaveLength(2);
    expect(scan).not.toHaveBeenCalledWith("gone");
  });

  it("create 文档走 note.create 并刷新扫描", async () => {
    const create = vi.fn(async () => ({
      noteId: "01NEW",
      relativePath: "无标题.md",
      versionToken: `sha256:${"e".repeat(64)}`,
    }));
    const scan = vi.fn(async () => ({
      vault: { vaultId: "v1", name: "我的笔记" },
      entries: [
        {
          noteId: "01NEW",
          relativePath: "无标题.md",
          kind: "document" as const,
          title: "无标题",
          parentPath: null,
          tags: [],
        },
      ],
    }));
    const api = mockApi({ scan });
    (api.note as unknown as { create: typeof create }).create = create;
    const cache = new DesktopVaultScanCache(api);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );
    const page = await repo.create({
      workspaceId: "v1",
      parentId: null,
      kind: "document",
      title: "无标题",
    });
    expect(page.id).toBe("01NEW");
    expect(create).toHaveBeenCalledWith({
      vaultId: "v1",
      directory: "",
      title: "无标题",
    });
    expect(scan).toHaveBeenCalled();
  });

  it("transient Vault 上 create 抛 VAULT_READ_ONLY", async () => {
    const api = mockApi({});
    const repo: PageRepository = new DesktopPageRepository(
      api,
      new DesktopVaultScanCache(api),
      metadataService(api, new DesktopVaultScanCache(api)).service,
      stateClient(api),
    );
    await expect(
      repo.create({
        workspaceId: "transient:t-1",
        parentId: null,
        kind: "document",
        title: "x",
      }),
    ).rejects.toMatchObject({ code: "VAULT_READ_ONLY" });
    expect(api.note.create).not.toHaveBeenCalled();
  });
  it("setLastOpened：页面不在扫描快照时 no-op（fire-and-forget 不抛错）", async () => {
    const api = mockApi({});
    const repo: PageRepository = new DesktopPageRepository(
      api,
      new DesktopVaultScanCache(api),
      metadataService(api, new DesktopVaultScanCache(api)).service,
      stateClient(api),
    );
    // "p" 不在 SCAN 中：找不到条目即 no-op；不得抛错（否则 MainArea
    // markOpened 产生 unhandled rejection）。
    await expect(repo.setLastOpened("p", Date.now())).resolves.toBeUndefined();
    expect(api.vaultState.patch).not.toHaveBeenCalled();
  });

  /* -------------------- R007 阶段 4：文件操作闭环 -------------------- */

  /** 阶段 4 测试装配：仓储 + 共享扫描缓存 + 来源缓存（move 同步断言用）。 */
  function pageRepo(api: E1DesktopAPI) {
    const cache = new DesktopVaultScanCache(api);
    const sources = new DesktopDocumentSourceCache();
    const repo = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache, sources).service,
      stateClient(api),
      sources,
    );
    return { repo, cache, sources };
  }

  it("create 分组 = vault.createDirectory 真实目录，返回 path: 页面并刷新扫描", async () => {
    const createDirectory = vi.fn(async () => ({
      relativePath: "新建分组",
    }));
    const scan = vi.fn(async () => ({
      vault: { vaultId: "v1", name: "我的笔记" },
      entries: [
        {
          noteId: null,
          relativePath: "新建分组",
          kind: "group" as const,
          title: "新建分组",
          parentPath: null,
          tags: [],
        },
      ],
    }));
    const api = mockApi({ createDirectory, scan });
    const { repo } = pageRepo(api);
    const page = await repo.create({
      workspaceId: "v1",
      parentId: null,
      kind: "group",
      title: "新建分组",
    });
    expect(createDirectory).toHaveBeenCalledWith({
      vaultId: "v1",
      parentRelativePath: "",
      name: "新建分组",
    });
    expect(page.id).toBe("path:新建分组");
    expect(page.kind).toBe("group");
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("create 分组到分组下：parentRelativePath 取父目录相对路径", async () => {
    const createDirectory = vi.fn(async () => ({
      relativePath: "学习/子分组",
    }));
    const api = mockApi({ createDirectory });
    const { repo } = pageRepo(api);
    await repo.listByWorkspace("v1"); // 预热扫描缓存（path:学习 条目）
    await repo.create({
      workspaceId: "v1",
      parentId: "path:学习",
      kind: "group",
      title: "子分组",
    });
    expect(createDirectory).toHaveBeenCalledWith({
      vaultId: "v1",
      parentRelativePath: "学习",
      name: "子分组",
    });
  });

  it("remove 文档与分组都走 vault.trash（rename 进回收站），并使扫描失效", async () => {
    const trash = vi.fn(async () => ({ operationId: "op-9" }));
    const scan = vi.fn(async () => SCAN);
    const api = mockApi({ trash, scan });
    const { repo } = pageRepo(api);
    await repo.listByWorkspace("v1"); // 预热缓存
    await repo.remove("01JABC");
    expect(trash).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    // 写后扫描缓存失效：下一次 listByWorkspace 重新扫描（第二次）。
    await repo.listByWorkspace("v1");
    await repo.remove("path:学习");
    expect(trash).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习",
    });
    await repo.listByWorkspace("v1");
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("remove/transient：仅预览 Vault 拒写（VAULT_READ_ONLY），不调 IPC", async () => {
    const trash = vi.fn(async () => ({ operationId: "op-1" }));
    const api = mockApi({ trash });
    const { repo } = pageRepo(api);
    await repo.listByWorkspace("transient:t-1"); // 以 transient 键缓存快照
    await expect(repo.remove("01JABC")).rejects.toMatchObject({
      code: "VAULT_READ_ONLY",
    });
    expect(trash).not.toHaveBeenCalled();
  });

  it("listByWorkspace 合并回收站条目：trash: id + deletedAt 非空 + basename 标题", async () => {
    const listTrash = vi.fn(async () => ({
      entries: [
        {
          operationId: "op-1",
          originalRelativePath: "学习/React.md",
          deletedAt: "2026-08-15T10:00:00.000Z",
          stableNoteId: "01JABC",
        },
        {
          operationId: "op-2",
          originalRelativePath: "旧目录",
          deletedAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    }));
    const api = mockApi({ listTrash });
    const { repo } = pageRepo(api);
    const pages = await repo.listByWorkspace("v1");
    const trashed = pages.filter((p) => p.deletedAt !== null);
    expect(trashed.map((p) => [p.id, p.title, p.kind, p.parentId])).toEqual([
      ["trash:v1/op-1", "React", "document", null],
      ["trash:v1/op-2", "旧目录", "group", null],
    ]);
    expect(trashed[0].deletedAt).toBe(Date.parse("2026-08-15T10:00:00.000Z"));
  });

  it("restore/purge 从 trash: id 解析 operationId；purgeTrashed 缺省清空", async () => {
    const restore = vi.fn(async () => ({ relativePath: "学习/React.md" }));
    const purgeTrash = vi.fn(async () => ({ purged: 1 }));
    const api = mockApi({ restore, purgeTrash });
    const { repo } = pageRepo(api);
    await repo.restore("trash:v1/op-1");
    expect(restore).toHaveBeenCalledWith({
      vaultId: "v1",
      operationId: "op-1",
    });
    await repo.purge("trash:v1/op-2");
    expect(purgeTrash).toHaveBeenCalledWith({
      vaultId: "v1",
      operationId: "op-2",
    });
    await repo.purgeTrashed("v1");
    expect(purgeTrash).toHaveBeenCalledWith({ vaultId: "v1" });
    // 非回收站 id：诚实失败 PAGE_NOT_FOUND，不调 IPC。
    await expect(repo.restore("01JABC")).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
    await expect(repo.purge("01JABC")).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });

  it("move 文档到目标目录：note.move + 来源缓存路径同步 + 扫描失效", async () => {
    const noteMove = vi.fn(async () => ({ relativePath: "React.md" }));
    const scan = vi.fn(async () => SCAN);
    const api = mockApi({ noteMove, scan });
    const { repo, sources } = pageRepo(api);
    const updatePath = vi.spyOn(sources, "updateRelativePath");
    await repo.listByWorkspace("v1"); // 预热缓存
    await repo.move("01JABC", null, 0);
    expect(noteMove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
      targetDirectory: "",
    });
    // 已打开文档的来源缓存路径同步（否则下次保存写回旧路径重建文件）。
    expect(updatePath).toHaveBeenCalledWith("01JABC", "React.md");
    await repo.listByWorkspace("v1");
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("move 冲突：VAULT_PATH_COLLISION → DomainError INVALID_INPUT", async () => {
    const noteMove = vi.fn(async () => {
      throw new DesktopIpcError(
        "VAULT_PATH_COLLISION",
        "目标位置已存在同名文件。",
      );
    });
    const api = mockApi({ noteMove });
    const { repo } = pageRepo(api);
    await repo.listByWorkspace("v1");
    const err = await repo.move("01JABC", null, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("INVALID_INPUT");
  });

  it("move/rename 分组：未注入 fileOperations 时诚实 NOT_IMPLEMENTED", async () => {
    const api = mockApi({});
    const { repo } = pageRepo(api);
    await repo.listByWorkspace("v1");
    await expect(repo.move("path:学习", null, 0)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    await expect(repo.rename("path:学习", "新名字")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(api.note.move).not.toHaveBeenCalled();
  });

  it("回收站不存在记录：VAULT_TRASH_NOT_FOUND → PAGE_NOT_FOUND", async () => {
    const restore = vi.fn(async () => {
      throw new DesktopIpcError("VAULT_TRASH_NOT_FOUND", "回收站记录不存在。");
    });
    const api = mockApi({ restore });
    const { repo } = pageRepo(api);
    await expect(repo.restore("trash:v1/gone")).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });
});

/**
 * DesktopContentRepository（R006-C3 §41.5）：pageId → 扫描缓存反查 →
 * note.read → MarkdownCodec.parse → DocumentContent；错误经 DomainError 映射。
 */
describe("DesktopContentRepository", () => {
  const SCAN_WITH_DOCS: VaultScanResult = {
    vault: { vaultId: "v1", name: "我的笔记" },
    entries: [
      {
        noteId: "01JABC",
        relativePath: "学习/React.md",
        kind: "document",
        title: "React 笔记",
        parentPath: null,
        tags: [],
      },
      {
        noteId: null,
        relativePath: "随笔.md",
        kind: "document",
        title: "随笔",
        parentPath: null,
        tags: [],
      },
    ],
  };

  function noteResult(
    markdown: string,
    relativePath: string,
    stableNoteId: string | null = null,
  ): ReadNoteResult {
    return {
      stableNoteId,
      relativePath,
      markdown,
      versionToken: `sha256:${"a".repeat(64)}`,
      source: {
        modifiedAt: 1722580000000,
        sizeBytes: new TextEncoder().encode(markdown).length,
      },
    };
  }

  /** 装配仓储并预热扫描缓存（会话加载先行，findDocument 只查已缓存快照）。 */
  async function setup(overrides: {
    scan?: E1DesktopAPI["vault"]["scan"];
    noteRead?: E1DesktopAPI["note"]["read"];
    markdown?: string;
    /** note.read 返回的 stableNoteId；缺省按路径：学习/React.md → 01JABC。 */
    stableNoteId?: string | null;
    vaultId?: string;
  }) {
    const vaultId = overrides.vaultId ?? "v1";
    const noteRead =
      overrides.noteRead ??
      vi.fn(async (input: { vaultId: string; relativePath: string }) => {
        const id =
          overrides.stableNoteId !== undefined
            ? overrides.stableNoteId
            : input.relativePath === "学习/React.md"
              ? "01JABC"
              : null;
        return noteResult(
          overrides.markdown ?? "# 标题\n\n正文内容",
          input.relativePath,
          id,
        );
      });
    const scanResult =
      overrides.scan ??
      vi.fn(async () => ({
        ...SCAN_WITH_DOCS,
        vault: { ...SCAN_WITH_DOCS.vault, vaultId },
      }));
    const api = mockApi({
      scan: scanResult,
      noteRead,
    });
    const cache = new DesktopVaultScanCache(api);
    const repo = new DesktopContentRepository(api, cache);
    // 扫描失败（Vault 不可访问）也照常走完预热：缓存不缓存拒绝态，
    // findDocument 反查落空 → PAGE_NOT_FOUND。
    await cache.scan(vaultId).catch(() => {});
    return { api, cache, repo, noteRead };
  }

  it("stable note ID：pageId → note.read → MarkdownCodec 解析为 DocumentContent", async () => {
    const { repo, noteRead } = await setup({});
    const content = await repo.get("01JABC");
    expect(noteRead).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    expect(content).toMatchObject({
      pageId: "01JABC",
      workspaceId: "v1",
      version: `sha256:${"a".repeat(64)}`,
      updatedAt: 1722580000000,
    });
    expect(content?.textSnapshot).toContain("标题");
    expect(content?.textSnapshot).toContain("正文内容");
    expect((content?.contentJson as { type?: string } | undefined)?.type).toBe(
      "doc",
    );
  });

  it("path:* 身份（无 Frontmatter id）：路径即页面 id，打开不写 id", async () => {
    const { repo, noteRead } = await setup({});
    const content = await repo.get("path:随笔.md");
    expect(noteRead).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "随笔.md",
    });
    expect(content?.pageId).toBe("path:随笔.md");
    expect(content?.workspaceId).toBe("v1");
  });

  it("扫描条目不存在 → DomainError(PAGE_NOT_FOUND)，中文文案", async () => {
    const { repo, noteRead } = await setup({});
    await expect(repo.get("不存在的页面")).rejects.toMatchObject({
      name: "DomainError",
      code: "PAGE_NOT_FOUND",
      message: expect.stringContaining("这篇笔记已经不存在"),
    });
    expect(noteRead).not.toHaveBeenCalled();
  });

  it("Vault 不可访问（扫描失败）→ PAGE_NOT_FOUND，不穿透原始错误", async () => {
    const { repo } = await setup({
      scan: vi.fn(async () => {
        throw new Error("目录被移走");
      }),
    });
    await expect(repo.get("01JABC")).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });

  it("note.read 报错按 §37 映射 DomainError；DOCUMENT_TOO_LARGE 透传 details", async () => {
    const cases: Array<{
      ipcCode: IpcErrorCode;
      domainCode: string;
      details?: Record<string, unknown>;
    }> = [
      { ipcCode: "NOTE_NOT_FOUND", domainCode: "PAGE_NOT_FOUND" },
      { ipcCode: "VAULT_NOT_FOUND", domainCode: "WORKSPACE_NOT_FOUND" },
      {
        ipcCode: "NOTE_PERMISSION_DENIED",
        domainCode: "NOTE_PERMISSION_DENIED",
      },
      { ipcCode: "NOTE_IO_ERROR", domainCode: "NOTE_IO_ERROR" },
      { ipcCode: "UNSUPPORTED_ENCODING", domainCode: "UNSUPPORTED_ENCODING" },
      {
        ipcCode: "DOCUMENT_TOO_LARGE",
        domainCode: "DOCUMENT_TOO_LARGE",
        details: { sizeBytes: 11534336, maxBytes: 10485760 },
      },
    ];
    for (const { ipcCode, domainCode, details } of cases) {
      const { repo } = await setup({
        noteRead: vi.fn(async () => {
          throw new DesktopIpcError(ipcCode, `ipc ${ipcCode}`, details);
        }),
      });
      const err = await repo.get("01JABC").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(domainCode);
      if (details) expect((err as DomainError).details).toEqual(details);
      // 中文用户文案，不是英文 IPC 原始 message。
      expect((err as DomainError).message).not.toContain("ipc");
    }
  });

  it("openDocument：兼容 Markdown → editable / read-write + 来源信息", async () => {
    const { repo } = await setup({ markdown: "# 标题\n\n普通段落" });
    const opened = await repo.openDocument("01JABC");
    expect(opened.access).toBe("editable");
    expect(opened.writePolicy).toEqual({ mode: "read-write" });
    expect(opened.compatibility).toEqual({ lossy: false, unsupported: [] });
    expect(opened.source).toMatchObject({
      relativePath: "学习/React.md",
      versionToken: `sha256:${"a".repeat(64)}`,
      modifiedAt: 1722580000000,
    });
    expect(opened.source.sizeBytes).toBeGreaterThan(0);
  });

  it("openDocument：lossy Markdown → read-only / confirmation lossy-source", async () => {
    const { repo } = await setup({
      markdown: '[[Wiki Link]]\n\n<div class="custom">\nHTML\n</div>',
    });
    const opened = await repo.openDocument("01JABC");
    expect(opened.access).toBe("read-only");
    expect(opened.writePolicy).toEqual({
      mode: "confirmation-required",
      reason: "lossy-source",
    });
    expect(opened.compatibility.lossy).toBe(true);
    const kinds = opened.compatibility.unsupported.map((f) => f.kind);
    expect(kinds).toContain("wiki-link");
    expect(kinds).toContain("raw-html");
  });

  it("openDocument：无 Frontmatter id（path:*）→ identity-adoption", async () => {
    const { repo } = await setup({
      markdown: "# 随笔\n\n正文",
      stableNoteId: null,
    });
    const opened = await repo.openDocument("path:随笔.md");
    expect(opened.access).toBe("read-only");
    expect(opened.writePolicy).toEqual({
      mode: "confirmation-required",
      reason: "identity-adoption",
    });
  });

  it("openDocument：transient Vault → read-only / transient-vault", async () => {
    const vaultId = "transient:preview-1";
    const { repo } = await setup({
      markdown: "# 标题\n\n普通段落",
      vaultId,
    });
    const opened = await repo.openDocument("01JABC");
    expect(opened.access).toBe("read-only");
    expect(opened.writePolicy).toEqual({
      mode: "read-only",
      reason: "transient-vault",
    });
  });

  it("save：经 SourceCache serialize → note.save；listAll/listByWorkspace 仍空（§35）", async () => {
    const save = vi.fn(async () => ({
      versionToken: `sha256:${"d".repeat(64)}`,
      source: { modifiedAt: 1722580001000, sizeBytes: 42 },
    }));
    const { repo, api } = await setup({});
    (api.note as unknown as { save: typeof save }).save = save;
    const opened = await repo.openDocument("01JABC");
    expect(opened.content).toBeDefined();
    const asPort: ContentRepository = repo;
    const result = await asPort.save(
      "01JABC",
      opened.content!.contentJson,
      "正文",
      opened.content!.version,
    );
    expect(result.version).toBe(`sha256:${"d".repeat(64)}`);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultId: "v1",
        relativePath: "学习/React.md",
        expectedVersionToken: opened.content!.version,
      }),
    );
    await expect(asPort.listAll()).resolves.toEqual([]);
    await expect(asPort.listByWorkspace("v1")).resolves.toEqual([]);
  });

  it("save：无 SourceCache → DOCUMENT_SOURCE_CONTEXT_REQUIRED", async () => {
    const { repo } = await setup({});
    await expect(
      repo.save("missing", { type: "doc", content: [] }, "", "sha256:x"),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_CONTEXT_REQUIRED" });
  });
});

describe("DesktopTagRepository", () => {
  it("标签与关联从扫描条目聚合", async () => {
    const api = mockApi({});
    const repo: TagRepository = new DesktopTagRepository(
      new DesktopVaultScanCache(api),
      metadataService(api, new DesktopVaultScanCache(api)).service,
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
    const repo: TagRepository = new DesktopTagRepository(
      cache,
      metadataService(api, cache).service,
    );
    await cache.scan("v1"); // 先建立缓存
    // noteId 与路径派生 id 都是各自条目的页面 id。
    expect(await repo.listPageTagIds("01JABC")).toEqual(["tag:前端"]);
    expect(await repo.listPageTagIds("path:b.md")).toEqual(["tag:随笔"]);
    expect(await repo.listPageTagIds("不存在的页面")).toEqual([]);
  });

  it("create 合成不持久化的标签实体（颜色确定性派生）；remove 仍 NOT_IMPLEMENTED", async () => {
    const api = mockApi({});
    const cache = new DesktopVaultScanCache(api);
    const repo: TagRepository = new DesktopTagRepository(
      cache,
      metadataService(api, cache).service,
    );
    // R007 阶段 1 §1.5：create 不写盘，持久化发生在随后的 setPageTags。
    const tag = await repo.create("v1", " 前端 ", "#000");
    expect(tag).toEqual({
      id: "tag:前端",
      workspaceId: "v1",
      name: "前端",
      color: deterministicTagColor("前端"),
    });
    // 同名标签颜色稳定（重启/跨会话不变）。
    expect((await repo.create("v1", "前端", "#000")).color).toBe(tag.color);
    await expect(repo.create("v1", "  ", "#000")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(repo.remove("t")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});

describe("维护桩与 DocumentWrite（C4-E/G）", () => {
  it("RevisionRepository：列表空；add/prune 为空操作", async () => {
    const repo: RevisionRepository = new DesktopRevisionRepository();
    await expect(repo.listByPage("p")).resolves.toEqual([]);
    await expect(repo.add("p", {}, "", "manual")).resolves.toBeNull();
    await expect(repo.pruneInterval("p", 1)).resolves.toBeUndefined();
  });

  it("AssetStore：读取空；removeOrphans 返回 0；remove 不抛错", async () => {
    const api = mockApi({});
    const scans = new DesktopVaultScanCache(api);
    const registry = new DesktopAssetRegistry();
    const store: AssetStore = new DesktopAssetStore(api, scans, registry);
    await expect(store.getMetadata("a")).resolves.toBeUndefined();
    await expect(store.getBinary("a")).resolves.toBeUndefined();
    await expect(store.listByDocument("p")).resolves.toEqual([]);
    await expect(store.removeOrphans("p", [])).resolves.toBe(0);
    await expect(store.remove("a")).resolves.toBeUndefined();
  });

  it("DocumentWriteRepository：createWithContent 走 note.create", async () => {
    const create = vi.fn(async () => ({
      noteId: "01DOC",
      relativePath: "模板.md",
      versionToken: `sha256:${"f".repeat(64)}`,
    }));
    const scan = vi.fn(async () => ({
      vault: { vaultId: "v1", name: "我的笔记" },
      entries: [
        {
          noteId: "01DOC",
          relativePath: "模板.md",
          kind: "document" as const,
          title: "模板",
          parentPath: null,
          tags: [],
        },
      ],
    }));
    const api = mockApi({ scan });
    (api.note as unknown as { create: typeof create }).create = create;
    const cache = new DesktopVaultScanCache(api);
    const sources = new DesktopDocumentSourceCache();
    const repo: DocumentWriteRepository = new DesktopDocumentWriteRepository(
      api,
      cache,
      sources,
    );
    const page = await repo.createWithContent({
      workspaceId: "v1",
      parentId: null,
      title: "模板",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      textSnapshot: "hi",
    });
    expect(page.id).toBe("01DOC");
    expect(create).toHaveBeenCalled();
    await expect(
      repo.replaceContent({
        pageId: "missing",
        contentJson: { type: "doc", content: [] },
        textSnapshot: "",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_CONTEXT_REQUIRED" });
  });
});

describe("DesktopVaultScanCache 路径索引（R006-C4.1-C）", () => {
  it("按 Vault 隔离；invalidate 清理路径；rescan 整体替换", async () => {
    const scan = vi.fn(async (vaultId: string) => ({
      vault: { vaultId, name: vaultId },
      entries: [
        {
          noteId: "01JABC",
          relativePath: vaultId === "v1" ? "a.md" : "b.md",
          kind: "document" as const,
          title: "n",
          parentPath: null,
          tags: [],
        },
      ],
    }));
    const api = mockApi({ scan });
    const cache = new DesktopVaultScanCache(api);
    await cache.scan("v1");
    await cache.scan("v2");
    expect(cache.getRelativePathSync("v1", "01JABC")).toBe("a.md");
    expect(cache.getRelativePathSync("v2", "01JABC")).toBe("b.md");
    cache.invalidate("v1");
    expect(cache.getRelativePathSync("v1", "01JABC")).toBeNull();
    expect(cache.getRelativePathSync("v2", "01JABC")).toBe("b.md");
    await cache.rescan("v1");
    expect(cache.getRelativePathSync("v1", "01JABC")).toBe("a.md");
  });

  it("删除文件后旧 relativePath / pageId 不再可解析", async () => {
    let entries = [
      {
        noteId: "keep",
        relativePath: "keep.md",
        kind: "document" as const,
        title: "留",
        parentPath: null,
        tags: [] as string[],
      },
      {
        noteId: "gone",
        relativePath: "gone.md",
        kind: "document" as const,
        title: "删",
        parentPath: null,
        tags: [] as string[],
      },
    ];
    const api = mockApi({
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "n" },
        entries,
      })),
    });
    const cache = new DesktopVaultScanCache(api);
    await cache.scan("v1");
    expect(cache.getRelativePathSync("v1", "gone")).toBe("gone.md");
    entries = [entries[0]!];
    await cache.rescan("v1");
    expect(cache.getRelativePathSync("v1", "gone")).toBeNull();
    expect(cache.getRelativePathSync("v1", "keep")).toBe("keep.md");
  });
});

describe("Session Alias 与扫描映射（R006-C4.1-B）", () => {
  it("Adoption 后 rescan Page.id 仍为 path:*；清空 alias 后为 stable id", async () => {
    const aliases = new DesktopIdentityAliasRegistry();
    const api = mockApi({
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "n" },
        entries: [
          {
            noteId: "abc-stable",
            relativePath: "React.md",
            kind: "document" as const,
            title: "React",
            parentPath: null,
            tags: [],
          },
        ],
      })),
    });
    const cache = new DesktopVaultScanCache(api, aliases);
    const pages: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );
    aliases.register({
      vaultId: "v1",
      sessionPageId: "path:React.md",
      stableNoteId: "abc-stable",
      relativePath: "React.md",
    });
    expect((await pages.listByWorkspace("v1")).map((p) => p.id)).toEqual([
      "path:React.md",
    ]);
    await cache.rescan("v1");
    expect((await pages.listByWorkspace("v1")).map((p) => p.id)).toEqual([
      "path:React.md",
    ]);
    aliases.clear();
    cache.invalidate("v1");
    expect((await pages.listByWorkspace("v1")).map((p) => p.id)).toEqual([
      "abc-stable",
    ]);
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

/**
 * R007 阶段 1（DSK-03）：元数据写入链路——rename / setPageTags 经
 * DesktopNoteMetadataService 调 note.patchMetadata；乐观锁起点、
 * Source Cache 同步、版本通道发布与扫描缓存失效。
 */
describe("Desktop 元数据写入（R007 阶段 1）", () => {
  const TOKEN_OLD = `sha256:${"o".repeat(64)}`;
  const TOKEN_NEW = `sha256:${"n".repeat(64)}`;
  const TOKEN_DISK = `sha256:${"d".repeat(64)}`;

  function patchOk() {
    return vi.fn(async () => ({
      versionToken: TOKEN_NEW,
      updatedAt: 1722580000000,
      stableNoteId: "01JABC",
    }));
  }

  /** 模拟「文档已打开」：Source Cache 写入来源上下文。 */
  function seedOpenDocument(
    sources: DesktopDocumentSourceCache,
    pageId = "01JABC",
  ) {
    sources.set(pageId, {
      vaultId: "v1",
      sessionPageId: pageId,
      relativePath: "学习/React.md",
      stableNoteId: "01JABC",
      metadata: { id: "01JABC", title: "React 笔记", tags: ["前端"] },
      frontmatterExtra: [],
      lineEnding: "lf",
      hadUtf8Bom: false,
      versionToken: TOKEN_OLD,
      compatibility: { lossy: false, unsupported: [] },
      writeSession: {
        sourceLossyApproved: false,
        outputLossyApproved: false,
        identityAdoptionApproved: false,
      },
    });
  }

  it("rename：已打开文档取 Source Cache 令牌，写后同步缓存并发布版本", async () => {
    const patchMetadata = patchOk();
    const api = mockApi({ notePatchMetadata: patchMetadata });
    const cache = new DesktopVaultScanCache(api);
    const { service, sources, versions } = metadataService(api, cache);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      service,
      stateClient(api),
    );
    await cache.scan("v1");
    seedOpenDocument(sources);
    const published: string[] = [];
    versions.subscribe("01JABC", (v) => published.push(v));

    await repo.rename("01JABC", "新标题");

    expect(patchMetadata).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
      expectedVersionToken: TOKEN_OLD,
      patch: { title: "新标题" },
    });
    // Source Cache：新版本 + 新标题，未涉及的 tags 不动。
    const ctx = sources.get("01JABC");
    expect(ctx?.versionToken).toBe(TOKEN_NEW);
    expect(ctx?.metadata.title).toBe("新标题");
    expect(ctx?.metadata.tags).toEqual(["前端"]);
    // 版本通道发布（打开文档的协调器据此推进，避免假冲突）。
    expect(published).toEqual([TOKEN_NEW]);
    expect(versions.latest("01JABC")).toBe(TOKEN_NEW);
    // 扫描缓存失效：路径索引清空，下次列表重新扫描。
    expect(cache.getRelativePathSync("v1", "01JABC")).toBeNull();
  });

  it("rename：未打开文档先 note.read 取磁盘当前版本作乐观锁起点", async () => {
    const patchMetadata = patchOk();
    const noteRead = vi.fn(async () => ({
      stableNoteId: "01JABC",
      relativePath: "学习/React.md",
      markdown: "---\nid: 01JABC\n---\n\n正文",
      versionToken: TOKEN_DISK,
      source: { modifiedAt: 1, sizeBytes: 10 },
    }));
    const api = mockApi({ notePatchMetadata: patchMetadata, noteRead });
    const cache = new DesktopVaultScanCache(api);
    const { service } = metadataService(api, cache);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      service,
      stateClient(api),
    );
    await cache.scan("v1");

    await repo.rename("01JABC", "新标题");

    expect(noteRead).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    expect(patchMetadata).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
      expectedVersionToken: TOKEN_DISK,
      patch: { title: "新标题" },
    });
  });

  it("setPageTags：tag:<name> id 还原为名称数组写入 Frontmatter", async () => {
    const patchMetadata = patchOk();
    const api = mockApi({ notePatchMetadata: patchMetadata });
    const cache = new DesktopVaultScanCache(api);
    const { service, sources } = metadataService(api, cache);
    const repo: TagRepository = new DesktopTagRepository(cache, service);
    await cache.scan("v1");
    seedOpenDocument(sources);

    await repo.setPageTags("01JABC", ["tag:前端", "tag:后端"]);

    expect(patchMetadata).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
      expectedVersionToken: TOKEN_OLD,
      patch: { tags: ["前端", "后端"] },
    });
    expect(sources.get("01JABC")?.metadata.tags).toEqual(["前端", "后端"]);
    expect(sources.get("01JABC")?.metadata.title).toBe("React 笔记");
  });

  it("外部已修改文件：DOCUMENT_CONFLICT 原样映射（进入既有冲突语义）", async () => {
    const patchMetadata = vi.fn(async () => {
      throw new DesktopIpcError("DOCUMENT_CONFLICT", "冲突");
    });
    const api = mockApi({ notePatchMetadata: patchMetadata });
    const cache = new DesktopVaultScanCache(api);
    const { service, sources } = metadataService(api, cache);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      service,
      stateClient(api),
    );
    await cache.scan("v1");
    seedOpenDocument(sources);

    await expect(repo.rename("01JABC", "x")).rejects.toMatchObject({
      code: "DOCUMENT_CONFLICT",
    });
    // 冲突时不推进缓存与版本。
    expect(sources.get("01JABC")?.versionToken).toBe(TOKEN_OLD);
  });

  it("transient 仅预览知识库拒写（不发起 IPC）", async () => {
    const patchMetadata = patchOk();
    const api = mockApi({
      notePatchMetadata: patchMetadata,
      scan: vi.fn(async (vaultId: string) => ({
        vault: { vaultId, name: "预览" },
        entries: [
          {
            noteId: "01T",
            relativePath: "a.md",
            kind: "document" as const,
            title: "a",
            parentPath: null,
            tags: [],
          },
        ],
      })),
    });
    const cache = new DesktopVaultScanCache(api);
    const { service } = metadataService(api, cache);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      service,
      stateClient(api),
    );
    await cache.scan("transient:t-1");

    await expect(repo.rename("01T", "x")).rejects.toMatchObject({
      code: "VAULT_READ_ONLY",
    });
    expect(patchMetadata).not.toHaveBeenCalled();
  });

  it("页面不存在 → PAGE_NOT_FOUND", async () => {
    const api = mockApi({ notePatchMetadata: patchOk() });
    const cache = new DesktopVaultScanCache(api);
    const { service } = metadataService(api, cache);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      service,
      stateClient(api),
    );
    await cache.scan("v1");

    await expect(repo.rename("不存在的页面", "x")).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });
});

/**
 * R007 阶段 2（DSK-04）：设备级交互状态——收藏/最近打开经 vaultState
 * IPC 落 userData/vault-state/（不进 Markdown）；列表映射合并 state；
 * stableNoteId 键优先、path 键兜底并在写入时迁移清空。
 */
describe("Desktop 交互状态（R007 阶段 2）", () => {
  const RECENT_V1 = {
    vaultId: "v1",
    absolutePath: "/tmp/a",
    displayName: "我的笔记",
    lastOpenedAt: "2026-08-09T10:00:00.000Z",
    accessible: true,
  };

  it("workspace.setFavorite 写 vault-state；list 合并收藏时间", async () => {
    const patch = vi.fn(async (input: PatchVaultStateInput) => ({
      ...createEmptyVaultState(),
      workspace: {
        favoriteAt: input.patch.workspace?.favoriteAt ?? null,
      },
    }));
    const api = mockApi({
      listRecent: vi.fn(async () => [RECENT_V1]),
      vaultStatePatch: patch,
    });
    const client = stateClient(api);
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      client,
    );

    await repo.setFavorite("v1", 1234);
    expect(patch).toHaveBeenCalledWith({
      vaultId: "v1",
      patch: { workspace: { favoriteAt: 1234 } },
    });
    // client 缓存被 patch 返回值刷新：list 不再发起 get IPC。
    const list = await repo.list();
    expect(list[0].favoriteAt).toBe(1234);

    await repo.setFavorite("v1", null);
    expect(patch).toHaveBeenLastCalledWith({
      vaultId: "v1",
      patch: { workspace: { favoriteAt: null } },
    });
  });

  it("page.setFavorite/setLastOpened 写 stableNoteId 键并迁移清空 path 键", async () => {
    const patch = vi.fn(async () => createEmptyVaultState());
    const api = mockApi({ vaultStatePatch: patch });
    const cache = new DesktopVaultScanCache(api);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );
    await cache.scan("v1");

    await repo.setFavorite("01JABC", 1000);
    expect(patch).toHaveBeenCalledWith({
      vaultId: "v1",
      patch: {
        pages: {
          "01JABC": { favoriteAt: 1000 },
          "path:学习/React.md": { favoriteAt: null, lastOpenedAt: null },
        },
      },
    });

    await repo.setLastOpened("01JABC", 2000);
    expect(patch).toHaveBeenLastCalledWith({
      vaultId: "v1",
      patch: {
        pages: {
          "01JABC": { lastOpenedAt: 2000 },
          "path:学习/React.md": { favoriteAt: null, lastOpenedAt: null },
        },
      },
    });
  });

  it("无 id 文档以 path:<relativePath> 为键", async () => {
    const patch = vi.fn(async () => createEmptyVaultState());
    const api = mockApi({
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "n" },
        entries: [
          {
            noteId: null,
            relativePath: "散落笔记.md",
            kind: "document" as const,
            title: "散落笔记",
            parentPath: null,
            tags: [],
          },
        ],
      })),
      vaultStatePatch: patch,
    });
    const cache = new DesktopVaultScanCache(api);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );
    await cache.scan("v1");

    await repo.setFavorite("path:散落笔记.md", 42);
    expect(patch).toHaveBeenCalledWith({
      vaultId: "v1",
      patch: { pages: { "path:散落笔记.md": { favoriteAt: 42 } } },
    });
  });

  it("listByWorkspace 合并 vault-state（stable 键优先，path 键兜底）", async () => {
    const state = createEmptyVaultState();
    state.pages["01JABC"] = { favoriteAt: 111, lastOpenedAt: 222 };
    const api = mockApi({
      vaultStateGet: vi.fn(async () => state),
    });
    const cache = new DesktopVaultScanCache(api);
    const repo: PageRepository = new DesktopPageRepository(
      api,
      cache,
      metadataService(api, cache).service,
      stateClient(api),
    );

    const pages = await repo.listByWorkspace("v1");
    const doc = pages.find((p) => p.id === "01JABC");
    expect(doc?.favoriteAt).toBe(111);
    expect(doc?.lastOpenedAt).toBe(222);
    // group 不携带交互状态。
    const group = pages.find((p) => p.id === "path:学习");
    expect(group?.favoriteAt).toBeNull();
  });

  it("transient 仅预览会话：状态只进内存镜像，不发起 IPC", async () => {
    const get = vi.fn(async () => createEmptyVaultState());
    const patch = vi.fn(async () => createEmptyVaultState());
    const api = mockApi({ vaultStateGet: get, vaultStatePatch: patch });
    const client = stateClient(api);
    const repo: WorkspaceRepository = new DesktopWorkspaceRepository(
      api,
      client,
    );

    await repo.setFavorite("transient:t-1", 777);
    expect(patch).not.toHaveBeenCalled();
    // 内存镜像生效：同 client 的 get 读到新值。
    expect((await client.get("transient:t-1")).workspace.favoriteAt).toBe(777);
    expect(get).not.toHaveBeenCalled();
  });
});
