// @vitest-environment node
/**
 * R006 阶段 1：preload 桥封装测试。
 * mock contextBridge/ipcRenderer，直接 import electron/preload/preload.ts
 * （源码 TS；构建产物才是 CJS）验证：
 * - 暴露键与 E1DesktopAPI 形状（platform/versions + vault/note/asset）；
 * - 每个方法的 channel 名与负载透传；
 * - IpcResult 信封解包语义：ok 取值（含 null），error 拒签为
 *   带 code 的 DesktopIpcError，畸形信封拒签 INTERNAL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type E1DesktopAPI } from "../../shared/ipc/contracts.js";
import { DesktopIpcError } from "../../shared/errors.js";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke },
}));

// preload 只做一次模块级暴露（resetModules 会让 DesktopIpcError 类身份
// 与测试 import 的类不一致，instanceof 断言失效），故整个文件共用一份
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
      "listRecent",
      "openRecent",
      "openSelection",
      "scan",
      "selectDirectory",
    ]);
    expect(Object.keys(api.note).sort()).toEqual(["create", "read", "save"]);
    expect(Object.keys(api.asset).sort()).toEqual([
      "import",
      "pick",
      "read",
      "resolveUrl",
    ]);
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

  it("字符串负载原样透传（scan/resolveUrl）", async () => {
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

  it("对象负载原样透传（note 三方法 + asset.import）", async () => {
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

    const importInput = {
      vaultId: "v1",
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "pick-token" as const, token: "p-token" },
    };
    await api.asset.import(importInput);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.assetImport, importInput);
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

  it("error 信封拒签为带 code 的 DesktopIpcError", async () => {
    invoke.mockResolvedValue({
      ok: false,
      error: { code: "NOT_IMPLEMENTED", message: "阶段 2 实现" },
    });
    const err = await api.vault.scan("v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopIpcError);
    expect((err as DesktopIpcError).code).toBe("NOT_IMPLEMENTED");
    expect((err as DesktopIpcError).message).toBe("阶段 2 实现");
  });

  it("畸形信封拒签 INTERNAL", async () => {
    invoke.mockResolvedValue({ unexpected: true });
    const err = await api.asset.pick().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopIpcError);
    expect((err as DesktopIpcError).code).toBe("INTERNAL");
  });
});
