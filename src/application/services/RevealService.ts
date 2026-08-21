/**
 * R008 Stage 2（§9，R8-07）：Reveal in File Manager port——平台无关接口。
 *
 * 在系统文件管理器中显示文档源文件 / 附件文件。只有具备本地文件系统
 * 真相的运行时（Desktop）装配本 port（能力字段 revealInFileManager）；
 * Web/内存容器不装配本字段，UI 一律以
 * `capabilities.revealInFileManager && services.revealService` 门控入口
 * （DUAL-01：只判断能力与 port 是否存在，不判断平台名称）。
 *
 * 实现约束（R8-07）：Renderer 只以会话身份（pageId/assetId）寻址，
 * absolutePath 只在 Main 内经授权边界 + PathGuard 解析；本接口与实现
 * 均不得出现绝对路径。
 */
export interface RevealService {
  /**
   * 在文件管理器中显示指定文档的源文件。
   * @returns false 表示无法定位（无来源上下文 / 文件已移动或删除 /
   *   IPC 失败）；调用方据此提示用户，成功无返回体。
   */
  revealDocument(pageId: string): Promise<boolean>;
  /**
   * 在文件管理器中显示指定附件文件。
   * @returns false 语义同 revealDocument。
   */
  revealAsset(assetId: string): Promise<boolean>;
}
