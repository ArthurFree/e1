/**
 * 运行时能力矩阵（R005 阶段 0，DUAL-01）。
 * 组件只能判断能力（`capabilities.revealInFileManager`），
 * 不得判断平台名称（isElectron / process.platform / window.electron）。
 * 字段语义表见 docs/architecture/runtime-boundaries.md。
 * Web 实现见 src/platform/web/webCapabilities.ts（仅 documentPersistence
 * 为 true，R006-C3 FR-22 新增；R005 阶段 2 接入 AppServices.capabilities）。
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
  /**
   * 接入了系统级安全存储体系保存 AI 密钥等机密（R008 Stage 1，R8-02）。
   * true 只表示「接入 native secret 体系」；本机当前是否真有安全 backend
   * 由运行态 SecretStorageStatus（SecretStore.getStatus）表达。
   */
  nativeSecrets: boolean;
  /** 附件拥有稳定文件路径，可被外部软件直接访问（而非 Blob/Object URL）。 */
  persistentAssetPaths: boolean;
  /**
   * 文档编辑会真实持久化（R006-C3 FR-22）：false 时编辑器不启动
   * SaveCoordinator，UI 必须明确提示「修改不会写回磁盘」。
   */
  documentPersistence: boolean;
}
