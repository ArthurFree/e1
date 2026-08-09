/**
 * 知识库命令服务（R005 批次 1）：知识库写编排从 WorkspaceProvider 下沉。
 *
 * - create：落库后广播 workspace-changed（其他标签页刷新知识库列表）；
 * - toggleFavorite / setLastOpened：纯写，不广播（与 Provider 现状一致）；
 *   favoriteAt 的 next 值由调用方算出（保留 Provider 现有时间戳语义）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现；
 * syncChannel 可选，缺省不广播（参照 DocumentCommitService 的处理方式）。
 */
import type { WorkspaceRepository } from "../../domain/repositories";
import type { Workspace } from "../../domain/types";
import type { ChangeChannel } from "../services/ChangeChannel";

export class WorkspaceCommandService {
  constructor(
    private readonly deps: {
      workspace: WorkspaceRepository;
      /** 变更广播频道（R004 §7.2；R005 阶段 8 §8.3 ChangeChannel port）；可选，缺省不广播。 */
      syncChannel?: ChangeChannel;
    },
  ) {}

  /** 创建知识库并广播 workspace-changed。 */
  async create(
    name: string,
    extra?: { icon?: string | null; description?: string },
  ): Promise<Workspace> {
    const ws = await this.deps.workspace.create(name, extra);
    this.deps.syncChannel?.publish({
      type: "workspace-changed",
      workspaceId: ws.id,
    });
    return ws;
  }

  /** 收藏/取消收藏（next 由调用方算出：时间戳或 null）；不广播。 */
  async toggleFavorite(id: string, next: number | null): Promise<void> {
    await this.deps.workspace.setFavorite(id, next);
  }

  /** 记录最近打开时间；不广播（fire-and-forget 由调用方保留）。 */
  async setLastOpened(id: string, at: number): Promise<void> {
    await this.deps.workspace.setLastOpened(id, at);
  }
}
