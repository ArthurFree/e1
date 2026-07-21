import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "notion-like-web";
export const DB_VERSION = 2;

export const STORE_WORKSPACES = "workspaces";
export const STORE_PAGES = "pages";
export const STORE_CONTENTS = "contents";
export const STORE_TAGS = "tags";
export const STORE_PAGE_TAGS = "pageTags";
export const STORE_PREFERENCES = "preferences";
export const STORE_TRASH = "trash";
export const STORE_REVISIONS = "revisions";
export const STORE_ATTACHMENTS = "attachments";

/**
 * v1 schema。导出供迁移测试用真实旧库 fixture：
 * 以版本 1 打开数据库并写入旧结构数据后，再用当前版本打开验证迁移。
 */
export function createV1Schema(db: IDBPDatabase) {
  const workspaces = db.createObjectStore(STORE_WORKSPACES, { keyPath: "id" });
  workspaces.createIndex("updatedAt", "updatedAt");

  const pages = db.createObjectStore(STORE_PAGES, { keyPath: "id" });
  pages.createIndex("workspaceId", "workspaceId");
  pages.createIndex("parentId", "parentId");
  pages.createIndex("deletedAt", "deletedAt");
  pages.createIndex("updatedAt", "updatedAt");

  const contents = db.createObjectStore(STORE_CONTENTS, { keyPath: "pageId" });
  contents.createIndex("updatedAt", "updatedAt");
  contents.createIndex("textSnapshot", "textSnapshot");

  const tags = db.createObjectStore(STORE_TAGS, { keyPath: "id" });
  tags.createIndex("workspaceId", "workspaceId");

  const pageTags = db.createObjectStore(STORE_PAGE_TAGS, {
    keyPath: ["pageId", "tagId"],
  });
  pageTags.createIndex("pageId", "pageId");
  pageTags.createIndex("tagId", "tagId");

  db.createObjectStore(STORE_PREFERENCES, { keyPath: "id" });
  db.createObjectStore(STORE_TRASH, { keyPath: "pageId" });
}

/**
 * v1 → v2：新增 revisions / attachments store；
 * Page.kind "folder" 原地迁移为 "group"，并补齐新增字段默认值；
 * Workspace 补齐 icon/description/homePageId/favoriteAt/lastOpenedAt。
 * 迁移在 upgrade 事务内完成，失败即整体回滚。
 */
async function upgradeToV2(db: IDBPDatabase, tx: { objectStore(name: string): unknown }) {
  const revisions = db.createObjectStore(STORE_REVISIONS, { keyPath: "id" });
  revisions.createIndex("pageId", "pageId");
  revisions.createIndex("pageId_createdAt", ["pageId", "createdAt"]);

  const attachments = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
  attachments.createIndex("pageId", "pageId");

  interface LegacyPage {
    id: string;
    kind: string;
    favoriteAt?: number | null;
    lastOpenedAt?: number | null;
    [key: string]: unknown;
  }
  const pagesStore = tx.objectStore(STORE_PAGES) as {
    openCursor(): Promise<{ value: LegacyPage; update(v: LegacyPage): void; continue(): Promise<unknown> } | null>;
  };
  let cursor = await pagesStore.openCursor();
  while (cursor) {
    const page = cursor.value;
    cursor.update({
      ...page,
      kind: page.kind === "folder" ? "group" : page.kind,
      favoriteAt: page.favoriteAt ?? null,
      lastOpenedAt: page.lastOpenedAt ?? null,
    });
    cursor = (await cursor.continue()) as typeof cursor;
  }

  interface LegacyWorkspace {
    id: string;
    icon?: string | null;
    description?: string;
    homePageId?: string | null;
    favoriteAt?: number | null;
    lastOpenedAt?: number | null;
    [key: string]: unknown;
  }
  const workspacesStore = tx.objectStore(STORE_WORKSPACES) as {
    openCursor(): Promise<{ value: LegacyWorkspace; update(v: LegacyWorkspace): void; continue(): Promise<unknown> } | null>;
  };
  let wsCursor = await workspacesStore.openCursor();
  while (wsCursor) {
    const ws = wsCursor.value;
    wsCursor.update({
      ...ws,
      icon: ws.icon ?? null,
      description: ws.description ?? "",
      homePageId: ws.homePageId ?? null,
      favoriteAt: ws.favoriteAt ?? null,
      lastOpenedAt: ws.lastOpenedAt ?? null,
    });
    wsCursor = (await wsCursor.continue()) as typeof wsCursor;
  }
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * 打开数据库。schema 变更通过提升 DB_VERSION 并在 upgrade 中
 * 按 oldVersion 逐级迁移；新增 store/索引写在对应分支里。
 */
export function getDB(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) createV1Schema(db);
      if (oldVersion < 2) void upgradeToV2(db, tx);
    },
  });
  return dbPromise;
}

/** 仅供测试：关闭连接并删除数据库。 */
export async function resetDB(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
