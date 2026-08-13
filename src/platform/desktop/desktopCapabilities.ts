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
  // 阶段 6：外部修改保存前 hash 检测 + 冲突面板落地后再评估
  // （完整文件监听明确不做，r006 §19 只做保存前检测）。
  fileWatching: false,
  // R007：原生「在文件管理器中显示」属桌面产品化范围。
  revealInFileManager: false,
  // R007：原生菜单体系属桌面产品化范围（r006 §3 非目标）。
  nativeMenu: false,
  // 阶段 6/后续批次：DesktopSecretStore 接系统安全存储后翻 true
  // （r006 §21；当前 secretStore 为内存实现）。
  nativeSecrets: false,
  // 阶段 5：附件落 Vault assets/ 真实文件后翻 true（r006 §13）。
  persistentAssetPaths: false,
  // R006-C4-E：note.save + DesktopContentRepository.save + Lossy Gate
  // + Transient Guard 已接通并通过测试后翻 true。
  documentPersistence: true,
};
