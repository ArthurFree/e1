/**
 * R006 阶段 1：Desktop 平台能力矩阵（DUAL-01）。
 * 规则（r006 §14）：没有实现的能力必须保持 false，不因为运行在
 * Electron 就全部翻 true；组件经 useAppServices().capabilities 判断
 * 能力，不得判断平台名称。
 */
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";

export const desktopCapabilities: RuntimeCapabilities = {
  // 已真实：selectDirectory 原生目录选择（阶段 1 唯一落地能力）。
  localDirectory: true,
  // R007 阶段 3：Main Watcher → events:vaultChanges → Renderer
  // reconciliation（DesktopExternalVaultChangeService）已接通，页面树经
  // ExternalVaultChangeBridge 自动刷新；文档层重载/冲突策略属 §3.4 后续。
  fileWatching: true,
  // R007 阶段 5：note.reveal / asset.reveal（PathGuard 后
  // shell.showItemInFolder）+ DesktopRevealService 已接通。
  revealInFileManager: true,
  // R007：原生菜单体系属桌面产品化范围（r006 §3 非目标）。
  nativeMenu: false,
  // R007 阶段 5：DesktopSecretStore 已接 Main safeStorage 持久化，
  // 但是否真用系统安全存储取决于运行时可用性（safeStorage 不可用时
  // Main 降级会话内存）——本静态缺省保持 false，装配根
  //（createDesktopRuntime）按 secret.status 实际值覆盖。
  nativeSecrets: false,
  // R006-C5：附件落 Vault assets/ 真实文件 + Hydration/Serialize 闭环。
  persistentAssetPaths: true,
  // R006-C4-E：note.save + DesktopContentRepository.save + Lossy Gate
  // + Transient Guard 已接通并通过测试后翻 true。
  documentPersistence: true,
};
