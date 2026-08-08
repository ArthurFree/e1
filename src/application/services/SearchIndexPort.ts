/**
 * 搜索索引 port（R005 阶段 6）：业务层只依赖本接口，不依赖具体实现。
 * Web 端为内存实现（platform/web/search/BrowserMemorySearchIndex），
 * Desktop 未来可换 SQLite 实现而不修改业务层。
 *
 * 查询语义与 domain/search.ts 的 searchPages 完全等价（标题命中在前、
 * 回收站排除、分组只匹配标题、snippet 一致），等价性由实现侧测试强制。
 *
 * 索引是派生数据：所有写路径以仓储落盘为准，索引同步失败不反向
 * 影响保存/重命名等主流程（调用侧容错，见 DocumentCommitService）。
 */
import type { Page, PageKind, SearchResult } from "../../domain/types";

/** upsertDocument 入参：索引一条文档所需的全部字段。 */
export interface SearchIndexUpsertInput {
  workspaceId: string;
  pageId: string;
  title: string;
  kind: PageKind;
  /**
   * 正文快照；缺省表示纯元数据更新（重命名/软删/恢复等），
   * 实现保留该条目已索引的正文文本。
   */
  textSnapshot?: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface SearchIndexPort {
  /**
   * 准备（或重建）一个工作区的索引：实现自行经仓储读取页面与正文
   * 快照（Web 内存实现：page.listByWorkspace + content.listByWorkspace），
   * 会话数据因此不再携带全部正文。幂等；重复调用等价于 rebuild。
   */
  prepareWorkspace(workspaceId: string): Promise<void>;

  /** 删除并重建工作区索引（内存索引被清除后的恢复通道）。 */
  rebuild(workspaceId: string): Promise<void>;

  /**
   * 页面镜像刷新后同步索引元数据：upsert 列表内页面（保留各条目
   * 已索引的正文）、移除列表外条目（purge）。索引未准备时为 no-op。
   */
  syncPages(workspaceId: string, pages: Page[]): Promise<void>;

  /** 单文档 upsert（重命名、原子创建、软删/恢复等）。 */
  upsertDocument(input: SearchIndexUpsertInput): Promise<void>;

  /**
   * 正文保存成功后的文本增量更新：提交路径只有 pageId + 新文本，
   * 不携带页面元数据，故独立于 upsertDocument。
   * 索引未准备或条目不存在时为 no-op。
   */
  updateText(
    pageId: string,
    textSnapshot: string,
    updatedAt: number,
  ): Promise<void>;

  /** 移除单条索引（彻底删除等场景预留）。 */
  removeDocument(workspaceId: string, pageId: string): Promise<void>;

  /** 工作区索引是否已准备（同步状态查询，供搜索回退路径判定）。 */
  has(workspaceId: string): boolean;

  /** 工作区内查询；未准备时返回空（由调用方回退全量扫描）。 */
  query(workspaceId: string, query: string): Promise<SearchResult[]>;
}
