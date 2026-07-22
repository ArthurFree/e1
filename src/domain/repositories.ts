/**
 * 仓储接口：UI 与状态层访问持久化数据的唯一入口。
 * 架构约束：界面只依赖仓储接口和领域状态，不直接触碰 IndexedDB；
 * 当前实现为 src/infrastructure/repositories.ts（IndexedDB），
 * 未来接入云同步或协作时可整体替换实现而不重写界面（见 docs/architecture.md）。
 */

import type {
  Attachment,
  DocumentContent,
  DocumentRevision,
  Page,
  PageKind,
  PageTag,
  Preferences,
  RevisionReason,
  Tag,
  Workspace,
} from "./types";

/** 创建页面入参；position 由实现按 nextPosition 追加到同级末尾。 */
export interface CreatePageInput {
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon?: string | null;
}

/** 知识库部分更新入参；缺省字段保持不变。 */
export interface UpdateWorkspaceInput {
  name?: string;
  icon?: string | null;
  description?: string;
}

/** 知识库仓储。 */
export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  create(name: string, extra?: { icon?: string | null; description?: string }): Promise<Workspace>;
  rename(id: string, name: string): Promise<void>;
  update(id: string, patch: UpdateWorkspaceInput): Promise<void>;
  /** 收藏/取消收藏（时间戳或 null）。 */
  setFavorite(id: string, favoriteAt: number | null): Promise<void>;
  /** 记录最近打开时间。 */
  setLastOpened(id: string, at: number): Promise<void>;
}

/** 页面仓储：树结构维护、收藏/浏览记录与回收站生命周期。 */
export interface PageRepository {
  /** 工作区全部页面（含回收站内的）。 */
  listByWorkspace(workspaceId: string): Promise<Page[]>;
  /** 跨知识库全部页面（最近/收藏等全局视图用，含回收站内的由调用方过滤）。 */
  listAll(): Promise<Page[]>;
  create(input: CreatePageInput): Promise<Page>;
  rename(id: string, title: string): Promise<void>;
  /** 收藏/取消收藏（时间戳或 null）。 */
  setFavorite(id: string, favoriteAt: number | null): Promise<void>;
  /** 记录最近浏览时间。 */
  setLastOpened(id: string, at: number): Promise<void>;
  /** 移动到新父级下的 index 位置（省略时追加到末尾）；形成环时抛错。 */
  move(id: string, newParentId: string | null, index?: number): Promise<void>;
  /** 软删除整棵子树并记录回收站信息。 */
  remove(id: string): Promise<void>;
  /** 恢复整棵子树；原父级不可用时回到根。 */
  restore(id: string): Promise<void>;
  /** 永久删除整棵子树（页面、正文、标签关联、回收站记录、版本与附件）。 */
  purge(id: string): Promise<void>;
  /** 清空工作区回收站：永久删除其中全部页面。 */
  purgeTrashed(workspaceId: string): Promise<void>;
}

/** 文档正文仓储。 */
export interface ContentRepository {
  /** 按 pageId 取正文；不存在时返回 undefined。 */
  get(pageId: string): Promise<DocumentContent | undefined>;
  /** 覆盖式保存（upsert）：contentJson 为唯一编辑真相，textSnapshot 同步更新。 */
  save(pageId: string, contentJson: unknown, textSnapshot: string): Promise<void>;
  /** 全部文档正文（全局搜索用）。 */
  listAll(): Promise<DocumentContent[]>;
}

/** 本地版本历史仓储（策略常量见 revisions.ts）。 */
export interface RevisionRepository {
  /** 按创建时间倒序；损坏记录跳过。 */
  listByPage(pageId: string): Promise<DocumentRevision[]>;
  /** 追加版本；与最新版本内容一致时不重复创建，返回 null。 */
  add(
    pageId: string,
    contentJson: unknown,
    textSnapshot: string,
    reason: RevisionReason,
  ): Promise<DocumentRevision | null>;
  /** 自动版本（interval）超出上限时清理最旧的，手动/恢复前版本不受影响。 */
  pruneInterval(pageId: string, keep: number): Promise<void>;
}

/** 创建附件入参。 */
export interface CreateAttachmentInput {
  pageId: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

/** 附件仓储：二进制直接存 IndexedDB。 */
export interface AttachmentRepository {
  /** 按 id 取附件；不存在时返回 undefined。 */
  get(id: string): Promise<Attachment | undefined>;
  listByPage(pageId: string): Promise<Attachment[]>;
  add(input: CreateAttachmentInput): Promise<Attachment>;
  remove(id: string): Promise<void>;
  /** 清理文档不再引用的孤儿附件，返回清理数量。 */
  removeOrphans(pageId: string, referencedIds: string[]): Promise<number>;
}

/** 标签与页面-标签关联仓储。 */
export interface TagRepository {
  listByWorkspace(workspaceId: string): Promise<Tag[]>;
  create(workspaceId: string, name: string, color: string): Promise<Tag>;
  /** 删除标签并解除所有页面关联。 */
  remove(id: string): Promise<void>;
  listPageTagIds(pageId: string): Promise<string[]>;
  /** 工作区全部页面-标签关联。 */
  listWorkspacePageTags(workspaceId: string): Promise<PageTag[]>;
  /** 覆盖式设置某页面的标签集合。 */
  setPageTags(pageId: string, tagIds: string[]): Promise<void>;
}

/** 浏览器本地偏好仓储（单例记录）。 */
export interface PreferencesRepository {
  /** 读取偏好；记录缺失或数据损坏时回退 DEFAULT_PREFERENCES。 */
  get(): Promise<Preferences>;
  /** 部分更新（id 不可改），返回合并后的完整偏好。 */
  update(patch: Partial<Omit<Preferences, "id">>): Promise<Preferences>;
}
