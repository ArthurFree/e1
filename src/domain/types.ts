export type PageKind = "document" | "group";

export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  description: string;
  /** 预留：自定义首页文档；R001 使用系统生成的知识库首页。 */
  homePageId: string | null;
  favoriteAt: number | null;
  lastOpenedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Page {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  position: number;
  favoriteAt: number | null;
  lastOpenedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentContent {
  pageId: string;
  contentJson: unknown;
  textSnapshot: string;
  updatedAt: number;
}

export type RevisionReason = "interval" | "before-restore" | "manual";

export interface DocumentRevision {
  id: string;
  pageId: string;
  contentJson: unknown;
  textSnapshot: string;
  createdAt: number;
  reason: RevisionReason;
}

export interface Attachment {
  id: string;
  pageId: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
}

export interface PageTag {
  pageId: string;
  tagId: string;
}

export type ThemeName = "light" | "dark";

export interface AIConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface Preferences {
  id: "preferences";
  theme: ThemeName;
  sidebarWidth: number;
  aiConfig: AIConfig | null;
  /** 上次路由（AppRoute 的 JSON 序列化）；null 表示首次安装，进入开始首页。 */
  lastRoute: string | null;
}

export interface TrashRecord {
  pageId: string;
  deletedAt: number;
  originalParentId: string | null;
}

export interface SearchResult {
  pageId: string;
  title: string;
  /** 正文命中时的上下文片段；仅标题命中时为空字符串。 */
  snippet: string;
}

export const DEFAULT_SIDEBAR_WIDTH = 224;

export const DEFAULT_PREFERENCES: Preferences = {
  id: "preferences",
  theme: "light",
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  aiConfig: null,
  lastRoute: null,
};
