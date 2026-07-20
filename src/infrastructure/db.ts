import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "notion-like-web";
export const DB_VERSION = 1;

export const STORE_WORKSPACES = "workspaces";
export const STORE_PAGES = "pages";
export const STORE_CONTENTS = "contents";
export const STORE_TAGS = "tags";
export const STORE_PAGE_TAGS = "pageTags";
export const STORE_PREFERENCES = "preferences";
export const STORE_TRASH = "trash";

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * 打开数据库。schema 变更通过提升 DB_VERSION 并在 upgrade 中
 * 按 oldVersion 逐级迁移；新增 store/索引写在对应分支里。
 */
export function getDB(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
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
