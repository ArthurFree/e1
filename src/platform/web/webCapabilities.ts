/**
 * Web 平台能力矩阵（R005 阶段 2，DUAL-01）：浏览器环境无本地目录、
 * 文件监听、原生菜单等桌面能力，六字段全 false。
 * 组件经 useAppServices().capabilities 判断能力，不得判断平台名称。
 */
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";

export const webCapabilities: RuntimeCapabilities = {
  // 浏览器不能以本地目录作为 Vault，数据只存 IndexedDB。
  localDirectory: false,
  // 无真实文件数据源，无从监听外部变更。
  fileWatching: false,
  // 浏览器无法在系统文件管理器中显示笔记或附件文件。
  revealInFileManager: false,
  // 菜单由 DOM 渲染，无系统原生菜单。
  nativeMenu: false,
  // AI 密钥只存 IndexedDB，无系统级安全存储。
  nativeSecrets: false,
  // 附件存 IndexedDB，只能以 Blob/Object URL 访问，无稳定文件路径。
  persistentAssetPaths: false,
};
