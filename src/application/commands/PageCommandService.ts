/**
 * 页面命令服务（R005 批次 1）：页面树写编排从 WorkspaceProvider 下沉。
 *
 * 广播语义严格对照 Provider 现状：
 * - create / rename / remove / move / restore / purge：落库后广播
 *   page-changed（广播所需 workspaceId 由参数传入，服务不持有会话状态；
 *   传 null 时不广播，对应会话未加载的路径）；
 * - purgeTrashed：广播 workspace-changed（回收站整体变化）；
 * - toggleFavorite / setLastOpened：不广播（收藏/浏览记录是本地行为）；
 * - rename 仅在 updatedPage 非空时同步搜索索引并广播（对应 Provider 的
 *   current 查找逻辑：页面不在当前会话镜像中时跳过）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type {
  CreatePageInput,
  PageRepository,
} from "../../domain/repositories";
import type { Page } from "../../domain/types";
import type { SearchIndexService } from "../services/SearchIndexService";
import type { SyncChannelService } from "../services/SyncChannelService";

export class PageCommandService {
  constructor(
    private readonly deps: {
      page: PageRepository;
      searchIndex: SearchIndexService;
      /** 跨标签页同步频道（R004 §7.2）；可选，缺省不广播。 */
      syncChannel?: SyncChannelService;
    },
  ) {}

  private postPageChanged(workspaceId: string | null, pageId: string): void {
    if (!workspaceId) return;
    this.deps.syncChannel?.post({ type: "page-changed", workspaceId, pageId });
  }

  /**
   * 创建页面并广播 page-changed。
   * 搜索索引不在此同步（现状靠 loadPages → syncPages 全量覆盖，保持不变）。
   */
  async create(input: CreatePageInput): Promise<Page> {
    const page = await this.deps.page.create(input);
    this.postPageChanged(input.workspaceId, page.id);
    return page;
  }

  /**
   * 重命名；updatedPage 为调用方合并后的最新页面（含新标题与 updatedAt），
   * 非空时同步搜索索引并广播，传 null 跳过（页面不在当前会话镜像中）。
   */
  async rename(
    id: string,
    title: string,
    updatedPage: Page | null,
  ): Promise<void> {
    await this.deps.page.rename(id, title);
    if (updatedPage) {
      this.deps.searchIndex.upsertPage(updatedPage);
      this.postPageChanged(updatedPage.workspaceId, id);
    }
  }

  /** 软删除整棵子树并广播 page-changed。 */
  async remove(id: string, workspaceId: string | null): Promise<void> {
    await this.deps.page.remove(id);
    this.postPageChanged(workspaceId, id);
  }

  /** 移动到新父级下的 index 位置并广播 page-changed。 */
  async move(
    id: string,
    parentId: string | null,
    index: number,
    workspaceId: string | null,
  ): Promise<void> {
    await this.deps.page.move(id, parentId, index);
    this.postPageChanged(workspaceId, id);
  }

  /** 从回收站恢复整棵子树并广播 page-changed。 */
  async restore(id: string, workspaceId: string | null): Promise<void> {
    await this.deps.page.restore(id);
    this.postPageChanged(workspaceId, id);
  }

  /** 永久删除整棵子树并广播 page-changed。 */
  async purge(id: string, workspaceId: string | null): Promise<void> {
    await this.deps.page.purge(id);
    this.postPageChanged(workspaceId, id);
  }

  /** 清空工作区回收站并广播 workspace-changed。 */
  async purgeTrashed(workspaceId: string): Promise<void> {
    await this.deps.page.purgeTrashed(workspaceId);
    this.deps.syncChannel?.post({ type: "workspace-changed", workspaceId });
  }

  /** 收藏/取消收藏（next 由调用方算出）；不广播（与现状一致）。 */
  async toggleFavorite(pageId: string, next: number | null): Promise<void> {
    await this.deps.page.setFavorite(pageId, next);
  }

  /** 记录最近浏览时间；不广播（与现状一致）。 */
  async setLastOpened(pageId: string, at: number): Promise<void> {
    await this.deps.page.setLastOpened(pageId, at);
  }
}
