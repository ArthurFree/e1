/**
 * 标签命令服务（R005 批次 1）：标签写编排从 WorkspaceProvider 下沉。
 *
 * create / remove / setPageTags 均为纯仓储写，不广播（与 Provider 现状一致）；
 * 写后的标签镜像刷新（loadTags）仍由调用方负责。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type { TagRepository } from "../../domain/repositories";
import type { Tag } from "../../domain/types";

export class TagCommandService {
  constructor(
    private readonly deps: {
      tag: TagRepository;
    },
  ) {}

  /** 创建标签。 */
  async create(workspaceId: string, name: string, color: string): Promise<Tag> {
    return this.deps.tag.create(workspaceId, name, color);
  }

  /** 删除标签并解除所有页面关联。 */
  async remove(id: string): Promise<void> {
    await this.deps.tag.remove(id);
  }

  /** 覆盖式设置某页面的标签集合。 */
  async setPageTags(pageId: string, tagIds: string[]): Promise<void> {
    await this.deps.tag.setPageTags(pageId, tagIds);
  }
}
