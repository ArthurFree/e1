// @vitest-environment node
/**
 * R006 阶段 1：preload 桥封装测试。
 * mock contextBridge/ipcRenderer，直接 import electron/preload/preload.ts
 * （源码 TS；构建产物才是 CJS）验证：
 * - 暴露键与 E1DesktopAPI 形状（platform/versions + vault/note/asset）；
 * - 每个方法的 channel 名与负载透传；
 * - IpcResult 信封解包语义：ok 取值（含 null），error 拒签为编码进
 *   message 的桥错误（跨 contextBridge 自定义属性丢失，载荷经
 *   decodeIpcBridgeError 还原），畸形信封拒签 INTERNAL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type E1DesktopAPI } from "../../shared/ipc/contracts.js";
import { decodeIpcBridgeError } from "../../shared/errors.js";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

// preload 只做一次模块级暴露（resetModules 会让共享错误类身份
// 与测试 import 的类不一致），故整个文件共用一份
// 暴露产物；invoke 在调用时取值，用例间 mockReset 即可隔离。
let api: E1DesktopAPI;

beforeEach(async () => {
  invoke.mockReset();
  if (!api) {
    await import("./preload.js");
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls[0][0]).toBe("e1");
    api = exposeInMainWorld.mock.calls[0][1] as E1DesktopAPI;
  }
});

describe("preload 暴露形状", () => {
  it("platform/versions + vault/note/asset 三组方法齐全", async () => {
    expect(api.platform).toBe("desktop");
    expect(api.versions).toBeTypeOf("object");
    expect(Object.keys(api.vault).sort()).toEqual([
      "createDirectory",
      "listRecent",
      "listTrash",
      "openRecent",
      "openSelection",
      "purgeTrash",
      "restore",
      "scan",
      "selectDirectory",
      "trash",
    ]);
    expect(Object.keys(api.note).sort()).toEqual([
      "create",
      "move",
      "patchMetadata",
      "read",
      "renameFile",
      "reveal",
      "save",
    ]);
    expect(Object.keys(api.asset).sort()).toEqual([
      "import",
      "pick",
      "read",
      "resolveUrl",
      "reveal",
    ]);
    expect(Object.keys(api.vaultState).sort()).toEqual(["get", "patch"]);
    // R007 阶段 5：机密存储组（safeStorage 持久化 + 可用性探测）。
    expect(Object.keys(api.secret).sort()).toEqual([
      "get",
      "remove",
      "set",
      "status",
    ]);
    // R008 Stage 4：全文搜索索引组（SQLite 派生索引）。
    expect(Object.keys(api.search).sort()).toEqual([
      "query",
      "rebuild",
      "relocate",
      "remove",
      "status",
      "upsert",
    ]);
    // R010 Stage 3：派生链接索引组（与搜索共库单连接）。
    expect(Object.keys(api.links).sort()).toEqual([
      "backlinks",
      "broken",
      "outgoing",
      "rebuild",
      "relocate",
      "remove",
      "status",
      "upsert",
    ]);
    // R009 Stage 6：应用更新组 + 更新状态订阅（Auto Update）。
    expect(Object.keys(api.update).sort()).toEqual([
      "check",
      "download",
      "getState",
      "install",
      "openReleasePage",
    ]);
    expect(Object.keys(api.events).sort()).toEqual([
      "subscribeUpdateStatus",
      "subscribeVaultChanges",
    ]);
  });
});

describe("R009 Stage 6：update 组与更新状态订阅", () => {
  it("update 组方法只传 channel（无入参）", async () => {
    invoke.mockResolvedValue({ ok: true, value: {} });
    await api.update.check();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.updateCheck, undefined);
    await api.update.download();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.updateDownload, undefined);
    await api.update.install();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.updateInstall, undefined);
    await api.update.openReleasePage();
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.updateOpenReleasePage,
      undefined,
    );
  });

  it("subscribeUpdateStatus：合法推送投递、非法推送丢弃、返回取消订阅", () => {
    const listener = vi.fn();
    const unsubscribe = api.events.subscribeUpdateStatus(listener);
    expect(on).toHaveBeenCalledWith(
      IPC_CHANNELS.eventsUpdateStatus,
      expect.any(Function),
    );
    const wrapped = on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.eventsUpdateStatus,
    )?.[1] as (event: unknown, payload: unknown) => void;

    const valid = {
      state: "available",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      canAutoInstall: true,
      releasePageUrl: "https://github.com/ArthurFree/e1/releases",
    };
    wrapped({}, valid);
    expect(listener).toHaveBeenCalledWith(valid);

    listener.mockClear();
    wrapped({}, { state: "bogus" });
    wrapped({}, null);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.eventsUpdateStatus,
      wrapped,
    );
  });
});

describe("channel 与负载透传", () => {
  it("无入参方法只传 channel", async () => {
    invoke.mockResolvedValue({ ok: true, value: null });
    await api.vault.selectDirectory();
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.vaultSelectDirectory,
      undefined,
    );
    await api.asset.pick();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.assetPick, undefined);
  });

  it("字符串负载原样透传（scan/resolveUrl/vaultState.get）", async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: { vault: { vaultId: "v", name: "n" }, entries: [] },
    });
    await api.vault.scan("v1");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.vaultScan, "v1");
    invoke.mockResolvedValue({ ok: true, value: "e1-asset://x" });
    await api.asset.resolveUrl("asset-1");
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.assetResolveUrl,
      "asset-1",
    );
    invoke.mockResolvedValue({
      ok: true,
      value: { version: 1, pages: {}, workspace: { favoriteAt: null } },
    });
    await api.vaultState.get("v1");
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.vaultStateGet, "v1");
  });

  it("vault.openSelection/openRecent 对象负载透传；vault.listRecent 只传 channel", async () => {
    const selectionInput = { selectionToken: "s-token", initialize: true };
    invoke.mockResolvedValue({ ok: true, value: {} });
    await api.vault.openSelection(selectionInput);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.vaultOpenSelection,
      selectionInput,
    );

    const recentInput = { vaultId: "v1" };
    await api.vault.openRecent(recentInput);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.vaultOpenRecent,
      recentInput,
    );

    invoke.mockResolvedValue({ ok: true, value: [] });
    await api.vault.listRecent();
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.vaultListRecent,
      undefined,
    );
  });

  it("对象负载原样透传（note 四方法 + asset.import）", async () => {
    const readInput = { vaultId: "v1", relativePath: "a.md" };
    invoke.mockResolvedValue({ ok: true, value: {} });
    await api.note.read(readInput);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.noteRead, readInput);

    const createInput = { vaultId: "v1", directory: "", title: "t" };
    await api.note.create(createInput);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.noteCreate, createInput);

    const saveInput = {
      vaultId: "v1",
      relativePath: "a.md",
      markdown: "m",
      expectedVersionToken: "sha256:x",
    };
    await api.note.save(saveInput);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.noteSave, saveInput);

    const patchInput = {
      vaultId: "v1",
      relativePath: "a.md",
      expectedVersionToken: "sha256:x",
      patch: { title: "新标题", tags: ["t"] },
    };
    await api.note.patchMetadata(patchInput);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.notePatchMetadata,
      patchInput,
    );

    const importInput = {
      vaultId: "v1",
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "pick-token" as const, token: "p-token" },
    };
    await api.asset.import(importInput);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.assetImport, importInput);

    const statePatch = {
      vaultId: "v1",
      patch: { pages: { "01JABC": { favoriteAt: 1 } } },
    };
    await api.vaultState.patch(statePatch);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.vaultStatePatch,
      statePatch,
    );
  });
});

describe("IpcResult 信封解包", () => {
  it("ok 信封取值（null 原样返回——取消选择语义）", async () => {
    invoke.mockResolvedValue({ ok: true, value: null });
    await expect(api.vault.selectDirectory()).resolves.toBeNull();
    const vault = {
      selectionToken: "s-token",
      vaultId: null,
      displayName: "Notes",
      initialized: false,
    };
    invoke.mockResolvedValue({ ok: true, value: vault });
    await expect(api.vault.selectDirectory()).resolves.toEqual(vault);
  });

  it("error 信封拒签为桥编码错误（载荷可解码还原）", async () => {
    invoke.mockResolvedValue({
      ok: false,
      error: { code: "NOT_IMPLEMENTED", message: "阶段 2 实现" },
    });
    const err = await api.vault.scan("v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const payload = decodeIpcBridgeError(err);
    expect(payload).not.toBeNull();
    expect(payload?.code).toBe("NOT_IMPLEMENTED");
    expect(payload?.message).toBe("阶段 2 实现");
  });

  it("畸形信封拒签 INTERNAL", async () => {
    invoke.mockResolvedValue({ unexpected: true });
    const err = await api.asset.pick().catch((e: unknown) => e);
    const payload = decodeIpcBridgeError(err);
    expect(payload?.code).toBe("INTERNAL");
  });
});
