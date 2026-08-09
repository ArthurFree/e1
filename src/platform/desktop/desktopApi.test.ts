/**
 * R006 阶段 1：getDesktopApi 测试——window.e1 缺失（纯浏览器误开
 * desktop.html）显式抛带指引的错误；存在时原样返回桌面桥。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getDesktopApi, type E1DesktopAPI } from "./desktopApi";

const stubApi = {
  platform: "desktop",
  versions: { electron: "43.0.0" },
  vault: {},
  note: {},
  asset: {},
} as unknown as E1DesktopAPI;

afterEach(() => {
  delete window.e1;
});

describe("getDesktopApi", () => {
  it("window.e1 缺失时抛带指引的错误", () => {
    expect(() => getDesktopApi()).toThrowError(/window\.e1/);
    expect(() => getDesktopApi()).toThrowError(/dev:desktop/);
  });

  it("window.e1 存在时原样返回", () => {
    window.e1 = stubApi;
    expect(getDesktopApi()).toBe(stubApi);
  });
});
