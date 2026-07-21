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

export interface CreatePageInput {
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon?: string | null;
}

export interface UpdateWorkspaceInput {
  name?: string;
  icon?: string | null;
  description?: string;
}

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  create(name: string, extra?: { icon?: string | null; description?: string }): Promise<Workspace>;
  rename(id: string, name: string): Promise<void>;
  update(id: string, patch: UpdateWorkspaceInput): Promise<void>;
  setFavorite(id: string, favoriteAt: number | null): Promise<void>;
  setLastOpened(id: string, at: number): Promise<void>;
}

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

export interface ContentRepository {
  get(pageId: string): Promise<DocumentContent | undefined>;
  save(pageId: string, contentJson: unknown, textSnapshot: string): Promise<void>;
  /** 全部文档正文（全局搜索用）。 */
  listAll(): Promise<DocumentContent[]>;
}

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

export interface CreateAttachmentInput {
  pageId: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

export interface AttachmentRepository {
  get(id: string): Promise<Attachment | undefined>;
  listByPage(pageId: string): Promise<Attachment[]>;
  add(input: CreateAttachmentInput): Promise<Attachment>;
  remove(id: string): Promise<void>;
  /** 清理文档不再引用的孤儿附件，返回清理数量。 */
  removeOrphans(pageId: string, referencedIds: string[]): Promise<number>;
}

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

export interface PreferencesRepository {
  get(): Promise<Preferences>;
  update(patch: Partial<Omit<Preferences, "id">>): Promise<Preferences>;
}
