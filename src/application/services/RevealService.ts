/**
 * 文件管理器定位 port（R007 阶段 5 §5.2）：「在文件管理器中显示」
 * 笔记/分组/附件的应用层入口。
 *
 * 只有「本地目录即真相」且具备原生 reveal 能力的运行时才装配
 *（Desktop，能力字段 revealInFileManager）；Web/内存容器不装配。
 * UI 一律以 `capabilities.revealInFileManager && services.reveal` 门控
 *（DUAL-01：只判断能力与服务是否存在，不判断平台名称）。
 *
 * 实现只暴露页面/资源身份（pageId/assetId），absolutePath 不出 Main
 *（DSK-02）；目标不存在等失败以带中文文案的 Error 拒签，由调用方
 *（侧栏错误条/节点状态文案）展示。
 */
export interface RevealService {
  /** 在系统文件管理器中显示页面（文档 .md 或分组目录）。 */
  revealPage(pageId: string): Promise<void>;
  /** 在系统文件管理器中显示附件文件。 */
  revealAsset(assetId: string): Promise<void>;
}
