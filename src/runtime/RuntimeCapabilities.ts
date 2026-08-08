/**
 * 运行时能力矩阵（R005 阶段 0，DUAL-01）。
 * 组件只能判断能力（`capabilities.revealInFileManager`），
 * 不得判断平台名称（isElectron / process.platform / window.electron）。
 * 字段语义表见 docs/architecture/runtime-boundaries.md。
 * Web 实现见 src/platform/web/webCapabilities.ts（六字段全 false，
 * R005 阶段 2 接入 AppServices.capabilities）。
 */
export interface RuntimeCapabilities {
  /** 能以本地目录作为 Vault 直接读写（文件夹即页面树）。 */
  localDirectory: boolean;
  /** 能监听真实数据源的外部变更并触发刷新/冲突提示。 */
  fileWatching: boolean;
  /** 能在系统文件管理器中显示笔记或附件文件。 */
  revealInFileManager: boolean;
  /** 能使用系统原生菜单（应用菜单/上下文菜单）。 */
  nativeMenu: boolean;
  /** 能使用系统级安全存储保存 AI 密钥等机密。 */
  nativeSecrets: boolean;
  /** 附件拥有稳定文件路径，可被外部软件直接访问（而非 Blob/Object URL）。 */
  persistentAssetPaths: boolean;
}
