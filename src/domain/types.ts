export type PageKind = "document" | "folder";

export interface Workspace {
  id: string;
  name: string;
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
}

export interface TrashRecord {
  pageId: string;
  deletedAt: number;
  originalParentId: string | null;
}

export const DEFAULT_SIDEBAR_WIDTH = 280;

export const DEFAULT_PREFERENCES: Preferences = {
  id: "preferences",
  theme: "light",
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  aiConfig: null,
};
