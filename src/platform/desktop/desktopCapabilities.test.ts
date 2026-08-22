/**
 * R006 阶段 1：Desktop 能力矩阵测试——形状锁定，防止能力提前翻 true
 * （r006 §14：没有实现的能力必须保持 false）。
 * R007 阶段 3：fileWatching 翻 true（Watcher → reconciliation 已接通）。
 * R007 阶段 5：revealInFileManager 翻 true（note.reveal/asset.reveal 已接通）；
 * nativeSecrets 为运行时探测值——本静态缺省保持 false，装配根按
 * secret.status 覆盖（覆盖路径见 createDesktopRuntime.test.ts）。
 */
import { describe, expect, it } from "vitest";
import { desktopCapabilities } from "./desktopCapabilities";

describe("desktopCapabilities", () => {
  it("七字段齐全：仅 nativeMenu/nativeSecrets 为 false（R007 阶段 5）", () => {
    expect(desktopCapabilities).toEqual({
      localDirectory: true,
      fileWatching: true,
      revealInFileManager: true,
      nativeMenu: false,
      nativeSecrets: false,
      persistentAssetPaths: true,
      documentPersistence: true,
    });
  });
});
