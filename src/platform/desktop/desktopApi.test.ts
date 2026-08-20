/**
 * R006 阶段 1：getDesktopApi 测试——window.e1 缺失（纯浏览器误开
 * desktop.html）显式抛带指引的错误；存在时返回解码包装后的桌面桥。
 * R007 桥错误修复：sandbox 下跨 contextBridge 的错误被重建为 plain Error
 * （自定义属性丢失），preload 把载荷编码进 message；本层解码重抛为
 * DesktopIpcError（code/details 还原），非桥编码错误与同步返回原样透传。
 */
import { describe, expect, it } from "vitest";
import { encodeIpcBridgeError } from "../../../shared/errors";
import { DesktopIpcError, getDesktopApi, type E1DesktopAPI } from "./desktopApi";

const bridgeScan = () =>
  Promise.reject(
    encodeIpcBridgeError({
      code: "VAULT_READ_ONLY",
      message: "仅预览知识库不能导入资源。",
      details: { vaultId: "v1" },
    }),
  );

const stubApi = {
  platform: "desktop",
  versions: { electron: "43.0.0" },
  vault: { scan: bridgeScan },
  vaultState: {},
  note: {},
  asset: { pick: () => Promise.reject(new Error("用户取消")) },
  events: { subscribeVaultChanges: () => () => undefined },
} as unknown as E1DesktopAPI;

describe("getDesktopApi", () => {
  it("window.e1 缺失时抛带指引的错误", () => {
    expect(() => getDesktopApi()).toThrowError(/window\.e1/);
    expect(() => getDesktopApi()).toThrowError(/dev:desktop/);
  });

  it("window.e1 存在时返回解码包装桥（非同一对象）", () => {
    window.e1 = stubApi;
    const api = getDesktopApi();
    expect(api).not.toBe(stubApi);
    expect(api.platform).toBe("desktop");
    // 缓存：再次获取为同一包装实例
    expect(getDesktopApi()).toBe(api);
  });

  it("桥编码错误解码为带 code/details 的 DesktopIpcError", async () => {
    const err = await getDesktopApi()
      .vault.scan("v1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopIpcError);
    expect((err as DesktopIpcError).code).toBe("VAULT_READ_ONLY");
    expect((err as DesktopIpcError).message).toBe("仅预览知识库不能导入资源。");
    expect((err as DesktopIpcError).details).toEqual({ vaultId: "v1" });
  });

  it("非桥编码错误原样重抛（不伪装为 IPC 错误）", async () => {
    const err = await getDesktopApi()
      .asset.pick()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DesktopIpcError);
    expect((err as Error).message).toBe("用户取消");
  });

  it("同步返回（取消订阅函数）原样透传", () => {
    const unsubscribe = getDesktopApi().events.subscribeVaultChanges(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});
