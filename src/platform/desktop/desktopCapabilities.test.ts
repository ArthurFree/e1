/**
 * R006 阶段 1：Desktop 能力矩阵测试——形状锁定，防止能力提前翻 true
 * （r006 §14：没有实现的能力必须保持 false）。
 * R007 阶段 3：fileWatching 翻 true（Watcher → reconciliation 已接通）。
 */
import { describe, expect, it } from "vitest";
import { desktopCapabilities } from "./desktopCapabilities";

describe("desktopCapabilities", () => {
  it("七字段齐全：localDirectory + fileWatching + persistentAssetPaths + documentPersistence 为 true（C4-E/C5，R007 阶段 3）", () => {
    expect(desktopCapabilities).toEqual({
      localDirectory: true,
      fileWatching: true,
      revealInFileManager: false,
      nativeMenu: false,
      nativeSecrets: false,
      persistentAssetPaths: true,
      documentPersistence: true,
    });
  });
});
