import { openDB, type IDBPDatabase } from "idb";

/**
 * db.ts —— IndexedDB 连接与 schema 定义。
 *
 * 基础设施层的存储入口：整个应用只有一个数据库，全部实体各用一个 object store。
 * 上层（repositories.ts）只通过 `getDB()` 拿连接，不直接关心版本与迁移。
 *
 * 版本策略（对应 R001 §6.2 的升级要求）：schema 变更通过提升 `DB_VERSION`，
 * 并在 `getDB()` 的 upgrade 回调里按 `oldVersion` 逐级迁移——每个版本一个分支，
 * 老库连续跳级时分支按顺序叠加执行。迁移全部在 upgrade 事务内完成，失败即整体回滚，
 * 不会留下半新半旧的 schema（见 R001 §6.3 兼容与回滚原则）。
 */
export const DB_NAME = "notion-like-web";
export const DB_VERSION = 2;

// 各 object store 名集中定义为常量，避免仓储层散落硬编码字符串。
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
 *
 * 注意这里只含 v1 的 7 个 store（无 revisions/attachments），
 * 索引集合也停留在 v1 状态；新增内容必须写进 `upgradeToV2`，不能回改本函数，
 * 否则迁移测试就测不到真实的旧库。
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
 *
 * 存量记录用游标逐条 `update` 回写：IndexedDB 没有批量更新，
 * 且必须在 upgrade 事务内做，不能另开事务。
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
 *
 * 连接以模块级 Promise 单例缓存：全应用共享同一条连接，
 * 并发调用在首次打开完成前复用同一个 Promise，不会重复触发 upgrade。
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

/**
 * 仅供测试：关闭连接并删除数据库。
 * `onblocked` 也按成功处理——测试环境里其他上下文可能仍持有连接，
 * 此时删除请求会被阻塞，但连接已关闭、Promise 已清空，对测试目的已足够。
 */
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
