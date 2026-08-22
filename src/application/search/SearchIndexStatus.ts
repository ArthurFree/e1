/**
 * 搜索索引状态机（R008 Stage 3 §13.1）：平台无关的索引健康表达。
 *
 * - missing：尚无索引（首次打开 Vault → 触发 rebuild）；
 * - building：初始/手动重建中（页面树与编辑器先用，不阻断打开）；
 * - ready：可正常搜索；
 * - degraded：增量维护失败（R8-06：正文保存不受影响，后续修复/重建）；
 * - corrupt：索引库损坏（关闭 → 备份 → 重建，不阻断 Vault 打开）。
 */
export type SearchIndexStatus =
  | { state: "missing" }
  | { state: "building"; progress?: number }
  | { state: "ready"; indexedDocuments: number }
  | { state: "degraded"; reason: string }
  | { state: "corrupt"; reason: string };
