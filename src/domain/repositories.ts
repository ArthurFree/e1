import type {
  DocumentContent,
  Page,
  PageKind,
  PageTag,
  Preferences,
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

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  create(name: string): Promise<Workspace>;
  rename(id: string, name: string): Promise<void>;
}

export interface PageRepository {
  /** 工作区全部页面（含回收站内的）。 */
  listByWorkspace(workspaceId: string): Promise<Page[]>;
  create(input: CreatePageInput): Promise<Page>;
  rename(id: string, title: string): Promise<void>;
  /** 移动到新父级下的 index 位置（省略时追加到末尾）；形成环时抛错。 */
  move(id: string, newParentId: string | null, index?: number): Promise<void>;
  /** 软删除整棵子树并记录回收站信息。 */
  remove(id: string): Promise<void>;
  /** 恢复整棵子树；原父级不可用时回到根。 */
  restore(id: string): Promise<void>;
  /** 永久删除整棵子树（页面、正文、标签关联、回收站记录）。 */
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
