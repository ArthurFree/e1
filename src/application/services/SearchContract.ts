/**
 * 全文搜索契约（R008 Stage 3 §10.3–§10.6 冻结）：Desktop 全文搜索的
 * 文档模型、结果模型、状态模型、port 接口与可执行查询语义。
 *
 * 与既有 `SearchIndexPort`（同目录，R005 标题搜索）的关系：
 * - 既有 port 服务 Web 标题搜索链路（workspaceId 语义 + 仓储取数），
 *   其实现与装配（BrowserMemorySearchIndex / DesktopTitleSearchIndex /
 *   SearchQueryService 回退路径）一律不动；
 * - 本契约是独立的全文搜索 port（vaultId 语义 + tags/body/权重排序/
 *   状态模型），Desktop SQLite 实现（electron/main/search/）与内存参照
 *   实现（src/infrastructure/memory/fullTextSearchIndex.ts）都必须通过
 *   同一套契约测试（src/test/searchIndexContract.ts，R8-04）。
 *
 * 架构不变量（R008 §5）：
 * - R8-03：索引是可重建派生数据，Markdown/仓储是唯一正文真相，
 *   索引数据绝不反向覆盖正文；
 * - R8-04：application/domain/components 只依赖本接口，不得出现
 *   node:sqlite / better-sqlite3 / SQL 语句；
 * - R8-06：任何索引失败不得阻断正文保存（调用侧容错，索引进入
 *   degraded 后自动修复或重建）。
 *
 * Stage 4 微调（已汇报）：模型类型与查询语义纯函数的唯一来源下沉至
 * shared/search/model.ts 与 shared/search/ranking.ts——Electron Main
 * 的搜索实现必须复用同一实现（「存储召回 + 契约层精排」分层），而
 * electron 不得 import src（shared/markdown/searchText.ts 同先例）。
 * 本文件原样 re-export 全部符号，冻结契约表面（模块路径导出面）不变。
 */
import type {
  SearchDocument,
  SearchIndexStatus,
  SearchQueryInput,
  SearchRebuildResult,
  SearchRemoveInput,
  SearchResult,
} from "../../../shared/search/model";

export type {
  SearchDocument,
  SearchIndexStatus,
  SearchMatchedField,
  SearchQueryInput,
  SearchRebuildResult,
  SearchRemoveInput,
  SearchResult,
} from "../../../shared/search/model";
export type { SearchMatch } from "../../../shared/search/ranking";
export {
  clampSearchLimit,
  compareSearchResults,
  makeSearchSnippet,
  normalizeSearchQuery,
  rankSearchDocuments,
  scoreSearchDocument,
  SEARCH_LIMIT_MAX,
  SEARCH_SCORE,
  SEARCH_SNIPPET_RADIUS,
} from "../../../shared/search/ranking";

/**
 * 全文搜索索引 port（§10.5 终值）。所有方法幂等；任何实现不得因索引
 * 内部错误抛出影响正文主流程的异常（实现自行归一并通过 getStatus
 * 暴露 degraded/corrupt）。
 */
export interface FullTextSearchIndexPort {
  /**
   * 准备（必要时创建）一个 vault 的索引；幂等。首次打开无索引的
   * Vault 后，重建/增量 upsert 驱动其进入 ready（§11.5），
   * 准备过程不得阻断页面树与编辑器。
   */
  prepareWorkspace(vaultId: string): Promise<void>;

  /**
   * 查询。vaultId 缺省时跨 vault 合并；索引 missing/building 的
   * vault 贡献空结果（由调用方决定回退或提示，§20）。
   */
  search(input: SearchQueryInput): Promise<SearchResult[]>;

  /**
   * 单文档 upsert：同 pageId 覆盖（旧文本立即消失）；同一文档重复
   * upsert 不产生重复结果。versionToken 未变化时实现可判重 no-op。
   */
  upsert(doc: SearchDocument): Promise<void>;

  /** 移除单条索引；条目或 vault 不存在时为 no-op。 */
  remove(input: SearchRemoveInput): Promise<void>;

  /**
   * 丢弃派生索引并从正文真相完整重建（§13.4 手动重建与 §13.3 损坏
   * 恢复共用本通道）。重建期间状态为 building，完成后 ready；
   * 重建不得触碰 Markdown。
   */
  rebuild(vaultId: string): Promise<SearchRebuildResult>;

  /** 查询 vault 的索引状态；未知 vault 返回 missing。 */
  getStatus(vaultId: string): Promise<SearchIndexStatus>;
}
