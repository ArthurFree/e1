import type {
  DocumentContent,
  Page,
  PageKind,
  Preferences,
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
  /** 移动到新的父级末尾；形成环时抛错。 */
  move(id: string, newParentId: string | null): Promise<void>;
  /** 软删除整棵子树并记录回收站信息。 */
  remove(id: string): Promise<void>;
  /** 恢复整棵子树；原父级不可用时回到根。 */
  restore(id: string): Promise<void>;
}

export interface ContentRepository {
  get(pageId: string): Promise<DocumentContent | undefined>;
  save(pageId: string, contentJson: unknown, textSnapshot: string): Promise<void>;
}

export interface PreferencesRepository {
  get(): Promise<Preferences>;
  update(patch: Partial<Omit<Preferences, "id">>): Promise<Preferences>;
}
