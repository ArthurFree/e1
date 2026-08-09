/**
 * R006 阶段 1：Desktop 能力矩阵测试——形状锁定，防止能力提前翻 true
 * （r006 §14：没有实现的能力必须保持 false）。
 */
import { describe, expect, it } from "vitest";
import { desktopCapabilities } from "./desktopCapabilities";

describe("desktopCapabilities", () => {
  it("六字段齐全且仅 localDirectory 为 true", () => {
    expect(desktopCapabilities).toEqual({
      localDirectory: true,
      fileWatching: false,
      revealInFileManager: false,
      nativeMenu: false,
      nativeSecrets: false,
      persistentAssetPaths: false,
    });
  });
});
