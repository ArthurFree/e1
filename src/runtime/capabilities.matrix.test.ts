/**
 * 锁定 docs/architecture/runtime-boundaries.md 中的 RuntimeCapabilities 矩阵。
 * Web / Desktop 七字段的当前实现值必须与该文档表格一致。
 * 变更任一能力时：同步更新本测试 + runtime-boundaries.md + 对应 *Capabilities.ts。
 */
import { describe, expect, it } from "vitest";
import { desktopCapabilities } from "../platform/desktop/desktopCapabilities";
import { webCapabilities } from "../platform/web/webCapabilities";

describe("RuntimeCapabilities matrix（锁定 architecture/runtime-boundaries.md）", () => {
  it("webCapabilities：仅 documentPersistence 为 true", () => {
    expect(webCapabilities).toEqual({
      localDirectory: false,
      fileWatching: false,
      revealInFileManager: false,
      nativeMenu: false,
      nativeSecrets: false,
      persistentAssetPaths: false,
      documentPersistence: true,
    });
  });

  it("desktopCapabilities：localDirectory + fileWatching + persistentAssetPaths + documentPersistence 为 true", () => {
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
