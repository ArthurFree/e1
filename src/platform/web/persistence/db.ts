import { openDB, type IDBPDatabase } from "idb";
import { increment } from "../../../application/devDiagnostics";

/**
 * db.ts —— IndexedDB 连接与 schema 定义。
 *
 * Web 平台的持久化适配器（PR6 起位于 platform/web/persistence/，与
 * platform/desktop 的文件系统实现对称）：整个应用只有一个数据库，
 * 全部实体各用一个 object store。
 * 上层（repositories.ts）只通过 `getDB()` 拿连接，不直接关心版本与迁移。
 *
 * 版本策略（对应 R001 §6.2 的升级要求）：schema 变更通过提升 `DB_VERSION`，
 * 并在 `getDB()` 的 upgrade 回调里按 `oldVersion` 逐级迁移——每个版本一个分支，
 * 老库连续跳级时分支按顺序叠加执行。迁移全部在 upgrade 事务内完成，失败即整体回滚，
 * 不会留下半新半旧的 schema（见 R001 §6.3 兼容与回滚原则）。
 */
export const DB_NAME = "notion-like-web";
export const DB_VERSION = 5;

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
/** 机密值（R005 阶段 8 §8.2 SecretStore 的 Web 实现）：{ name, value }。 */
export const STORE_SECRETS = "secrets";

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
async function upgradeToV2(
  db: IDBPDatabase,
  tx: { objectStore(name: string): unknown },
) {
  const revisions = db.createObjectStore(STORE_REVISIONS, { keyPath: "id" });
  revisions.createIndex("pageId", "pageId");
  revisions.createIndex("pageId_createdAt", ["pageId", "createdAt"]);

  const attachments = db.createObjectStore(STORE_ATTACHMENTS, {
    keyPath: "id",
  });
  attachments.createIndex("pageId", "pageId");

  interface LegacyPage {
    id: string;
    kind: string;
    favoriteAt?: number | null;
    lastOpenedAt?: number | null;
    [key: string]: unknown;
  }
  const pagesStore = tx.objectStore(STORE_PAGES) as {
    openCursor(): Promise<{
      value: LegacyPage;
      update(v: LegacyPage): void;
      continue(): Promise<unknown>;
    } | null>;
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
    openCursor(): Promise<{
      value: LegacyWorkspace;
      update(v: LegacyWorkspace): void;
      continue(): Promise<unknown>;
    } | null>;
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
 * 存储连接生命周期回调（R004 阶段 7 §7.1）：db.ts 不 import UI，
 * 由装配根（browserServices）注入，转发到应用层事件总线。
 */
export interface StorageConnectionCallbacks {
  /** 本标签页发起的升级被其他标签页阻塞：提示关闭其他标签页。 */
  onBlocked?(): void;
  /** 其他标签页完成了升级（本连接随之关闭）：提示刷新页面。 */
  onVersionChange?(): void;
  /** 连接异常终止：缓存已清空，下次操作自动重连。 */
  onTerminated?(): void;
}

let connectionCallbacks: StorageConnectionCallbacks = {};

/** 注入连接生命周期回调（装配根调用）；重复调用整体替换。 */
export function setStorageConnectionCallbacks(
  callbacks: StorageConnectionCallbacks,
): void {
  connectionCallbacks = callbacks;
}

/** 清空连接缓存（仅当缓存仍是该连接时）：后续操作重新打开连接。 */
function clearCachedConnection(expected: Promise<IDBPDatabase>): void {
  if (dbPromise === expected) dbPromise = null;
}

/**
 * v2 → v3（R003 阶段 7）：新增热点查询索引，无数据迁移。
 * - pages 复合索引 `workspaceId_parentId` / `workspaceId_updatedAt`；
 * - trash 增加 `deletedAt` 索引。
 * 注意：IndexedDB 索引会排除键为 null 的记录（如 parentId 为 null 的顶层页面），
 * 顶层兄弟查询回退到「workspaceId 索引 + 内存过滤」，不依赖复合索引覆盖顶层。
 */
async function upgradeToV3(
  _db: IDBPDatabase,
  tx: { objectStore(name: string): unknown },
) {
  const pages = tx.objectStore(STORE_PAGES) as {
    createIndex(name: string, keyPath: string | string[]): void;
  };
  pages.createIndex("workspaceId_parentId", ["workspaceId", "parentId"]);
  pages.createIndex("workspaceId_updatedAt", ["workspaceId", "updatedAt"]);
  const trash = tx.objectStore(STORE_TRASH) as {
    createIndex(name: string, keyPath: string): void;
  };
  trash.createIndex("deletedAt", "deletedAt");
}

/**
 * v3 → v4（R004 阶段 5）：contents / pageTags 增加工作区维度。
 * - 数据迁移：以 pages 建立 pageId → workspaceId 映射，逐条回写
 *   contents 与 pageTags 的 workspaceId；页面已不存在的孤立记录
 *   不猜测、不删除，统计数量并记录（console.warn + devDiagnostics），
 *   跳过该条（其 workspaceId 缺失，天然不会进入新索引）。
 * - 新索引：contents `workspaceId`、`workspaceId_updatedAt`（复合）、
 *   pageTags `workspaceId`。
 * 全部在 upgrade 事务内完成，失败即整体回滚。
 */
async function upgradeToV4(
  _db: IDBPDatabase,
  tx: { objectStore(name: string): unknown },
) {
  interface CursorStore<T> {
    openCursor(): Promise<{
      value: T;
      update(v: T): void;
      continue(): Promise<unknown>;
    } | null>;
  }
  const pagesStore = tx.objectStore(STORE_PAGES) as {
    getAll(): Promise<{ id: string; workspaceId: string }[]>;
  };
  const workspaceByPageId = new Map<string, string>();
  for (const page of await pagesStore.getAll()) {
    if (
      page &&
      typeof page.id === "string" &&
      typeof page.workspaceId === "string"
    ) {
      workspaceByPageId.set(page.id, page.workspaceId);
    }
  }

  // 先建索引再回写：游标 update 会同步维护索引项。
  const contentsStore = tx.objectStore(STORE_CONTENTS) as CursorStore<{
    pageId: string;
    workspaceId?: string;
    [key: string]: unknown;
  }> & { createIndex(name: string, keyPath: string | string[]): void };
  contentsStore.createIndex("workspaceId", "workspaceId");
  contentsStore.createIndex("workspaceId_updatedAt", [
    "workspaceId",
    "updatedAt",
  ]);

  let orphanContents = 0;
  let cursor = await contentsStore.openCursor();
  while (cursor) {
    const record = cursor.value;
    const workspaceId = workspaceByPageId.get(record.pageId);
    if (workspaceId === undefined) {
      orphanContents += 1;
    } else if (record.workspaceId !== workspaceId) {
      cursor.update({ ...record, workspaceId });
    }
    cursor = (await cursor.continue()) as typeof cursor;
  }

  const pageTagsStore = tx.objectStore(STORE_PAGE_TAGS) as CursorStore<{
    pageId: string;
    tagId: string;
    workspaceId?: string;
  }> & { createIndex(name: string, keyPath: string): void };
  pageTagsStore.createIndex("workspaceId", "workspaceId");

  let orphanPageTags = 0;
  let ptCursor = await pageTagsStore.openCursor();
  while (ptCursor) {
    const record = ptCursor.value;
    const workspaceId = workspaceByPageId.get(record.pageId);
    if (workspaceId === undefined) {
      orphanPageTags += 1;
    } else if (record.workspaceId !== workspaceId) {
      ptCursor.update({ ...record, workspaceId });
    }
    ptCursor = (await ptCursor.continue()) as typeof ptCursor;
  }

  // 孤立记录不猜测归属、不删除：只统计与记录（仅数量，不含内容）。
  if (orphanContents > 0 || orphanPageTags > 0) {
    console.warn(
      `[db] v4 迁移跳过孤立记录：正文 ${orphanContents} 条，页面标签关联 ${orphanPageTags} 条`,
    );
    increment(
      "db-migration",
      `v4 孤立记录: contents=${orphanContents} pageTags=${orphanPageTags}`,
    );
  }
}

/**
 * v4 → v5（R005 阶段 8 §8.2）：新增 secrets store（SecretStore 的 Web
 * 实现），并把偏好记录中旧版 aiConfig 的 apiKey 迁移为 "ai.apiKey"
 * secret——机密从普通偏好模型剥离，偏好记录改写为 aiEndpoint/aiModel
 * 并删除 aiConfig 字段。迁移在 upgrade 事务内完成，失败即整体回滚；
 * 对无旧配置的记录为 no-op（幂等语义由「upgrade 只执行一次」保证）。
 */
async function upgradeToV5(
  db: IDBPDatabase,
  tx: { objectStore(name: string): unknown },
) {
  db.createObjectStore(STORE_SECRETS, { keyPath: "name" });

  interface Store {
    get(key: string): Promise<unknown>;
    put(value: unknown): Promise<unknown>;
  }
  const prefsStore = tx.objectStore(STORE_PREFERENCES) as Store;
  const stored = await prefsStore.get("preferences");
  if (!stored || typeof stored !== "object") return;
  const record = stored as Record<string, unknown>;
  const ai = record.aiConfig;
  if (ai !== null && typeof ai === "object") {
    const { endpoint, model, apiKey } = ai as {
      endpoint?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
    if (typeof apiKey === "string" && apiKey !== "") {
      const secretsStore = tx.objectStore(STORE_SECRETS) as Store;
      await secretsStore.put({ name: "ai.apiKey", value: apiKey });
    }
    // 已被新代码写过的记录（aiEndpoint 已存在）不覆盖。
    if (record.aiEndpoint === undefined) {
      record.aiEndpoint = typeof endpoint === "string" ? endpoint : null;
    }
    if (record.aiModel === undefined) {
      record.aiModel = typeof model === "string" ? model : null;
    }
  }
  delete record.aiConfig;
  await prefsStore.put(record);
}

/**
 * 打开数据库。schema 变更通过提升 DB_VERSION 并在 upgrade 中
 * 按 oldVersion 逐级迁移；新增 store/索引写在对应分支里。
 *
 * 连接以模块级 Promise 单例缓存：全应用共享同一条连接，
 * 并发调用在首次打开完成前复用同一个 Promise，不会重复触发 upgrade。
 */
export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    // 已打开的连接实例：blocking（versionchange）时必须同步关闭——
    // 异步关闭会让发起升级的另一标签页先收到 blocked。
    let openedDb: IDBPDatabase | null = null;
    const promise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, newVersion, tx) {
        try {
          if (oldVersion < 1) createV1Schema(db);
          if (oldVersion < 2) await upgradeToV2(db, tx);
          if (oldVersion < 3) await upgradeToV3(db, tx);
          if (oldVersion < 4) await upgradeToV4(db, tx);
          if (oldVersion < 5) await upgradeToV5(db, tx);
          // 开发诊断：迁移结果（仅版本号，R003 §8.3）。
          increment(
            "db-migration",
            `v${oldVersion}→v${newVersion ?? DB_VERSION}`,
          );
        } catch (err) {
          increment("db-migration", `v${oldVersion} 迁移失败`);
          throw err;
        }
      },
      // 连接生命周期（R004 §7.1）：
      // blocked——本标签页的升级被其他（旧代码）标签页阻塞，提示用户关闭它们；
      blocked() {
        increment("db-connection", "blocked");
        connectionCallbacks.onBlocked?.();
      },
      // blocking（即 versionchange）——其他标签页发起升级：同步关闭本连接
      // 让升级完成；清空缓存，后续操作以新 schema 重连，UI 提示刷新。
      blocking() {
        increment("db-connection", "versionchange");
        openedDb?.close();
        clearCachedConnection(promise);
        connectionCallbacks.onVersionChange?.();
      },
      // terminated——连接异常终止（如浏览器回收）：清缓存，下次操作重连；
      // 在途读写错误向上抛，走既有错误页/保存错误通道。
      terminated() {
        increment("db-connection", "terminated");
        clearCachedConnection(promise);
        connectionCallbacks.onTerminated?.();
      },
    });
    dbPromise = promise;
    promise.then(
      (db) => {
        openedDb = db;
      },
      // 打开失败（如升级事务失败或版本回退）：清缓存，允许下次操作重试，
      // 避免缓存着一个已拒绝的 Promise 永久卡死。
      () => clearCachedConnection(promise),
    );
  }
  return dbPromise;
}

/**
 * 仅供测试：关闭连接并删除数据库。
 * `onblocked` 也按成功处理——测试环境里其他上下文可能仍持有连接，
 * 此时删除请求会被阻塞，但连接已关闭、Promise 已清空，对测试目的已足够。
 */
export async function resetDB(): Promise<void> {
  if (dbPromise) {
    const promise = dbPromise;
    dbPromise = null;
    // 打开可能已失败（如版本回退）：失败时无连接可关，直接继续删除。
    await promise.then(
      (db) => db.close(),
      () => {},
    );
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
