/**
 * R006 阶段 1：Desktop 能力矩阵测试——形状锁定，防止能力提前翻 true
 * （r006 §14：没有实现的能力必须保持 false）。
 * R007 阶段 3：fileWatching 翻 true（Watcher → reconciliation 已接通）。
 * R008 Stage 1：nativeSecrets 翻 true（safeStorage 安全存储已接通，
 * 运行态持久性由 SecretStorageStatus 表达，R8-02）。
 */
import { describe, expect, it } from "vitest";
import { desktopCapabilities } from "./desktopCapabilities";

describe("desktopCapabilities", () => {
  it("七字段齐全：localDirectory + fileWatching + nativeSecrets + persistentAssetPaths + documentPersistence 为 true", () => {
    expect(desktopCapabilities).toEqual({
      localDirectory: true,
      fileWatching: true,
      revealInFileManager: false,
      nativeMenu: false,
      nativeSecrets: true,
      persistentAssetPaths: true,
      documentPersistence: true,
    });
  });
});
