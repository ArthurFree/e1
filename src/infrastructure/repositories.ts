import type {
  AttachmentRepository,
  ContentRepository,
  CreateAttachmentInput,
  CreatePageInput,
  DocumentWriteRepository,
  PageRepository,
  PreferencesRepository,
  RevisionRepository,
  TagRepository,
  UpdateWorkspaceInput,
  WorkspaceRepository,
} from "../domain/repositories";
import {
  childrenOf,
  collectSubtreeIds,
  movePage,
  nextPosition,
  wouldCreateCycle,
} from "../domain/pageTree";
import { DomainError } from "../domain/errors";
import {
  revisionContentBytes,
  selectRevisionsToPrune,
} from "../domain/revisions";
import { parseDocumentContent } from "../domain/validation/documentContent";
import {
  DEFAULT_PREFERENCES,
  type Attachment,
  type DocumentContent,
  type DocumentRevision,
  type Page,
  type PageTag,
  type Preferences,
  type RevisionReason,
  type Tag,
  type Workspace,
} from "../domain/types";
import {
  getDB,
  STORE_ATTACHMENTS,
  STORE_CONTENTS,
  STORE_PAGES,
  STORE_PAGE_TAGS,
  STORE_PREFERENCES,
  STORE_REVISIONS,
  STORE_TAGS,
  STORE_TRASH,
  STORE_WORKSPACES,
} from "./db";
import type { IDBPDatabase, IDBPTransaction } from "idb";
import { ensureSeeded } from "./seed";
import { createId } from "./id";

/**
 * repositories.ts —— 领域仓储接口的 IndexedDB 实现。
 *
 * 架构位置：实现 `domain/repositories.ts` 定义的全部接口，是 UI/状态层
 * 与 IndexedDB 之间的唯一数据通道；页面树的纯逻辑（排序、子树收集、成环检测）
 * 全部委托给 `domain/pageTree.ts`，本文件只做持久化与多 store 事务编排。
 *
 * 横切策略：
 * - 损坏数据降级：读路径一律经 normalize* / isValid* 校验，核心字段非法的记录
 *   跳过（返回 null/过滤掉），旧版本缺失的新字段按默认值补齐（对应 R001 §6.3）；
 *   写路径遇目标记录损坏则抛错，避免在脏数据上继续写。
 * - 多步写入一律包在单个 IndexedDB 事务里（页面+正文、回收站、级联删除），
 *   保证要么全部落库要么整体回滚，不留中间态。
 * - 列表接口先 `ensureSeeded`：首次启动惰性写入预置知识库，UI 无需感知。
 */

/** 核心字段缺失/非法时返回 null；新增字段按默认值补齐（旧数据降级）。 */
function normalizePage(record: unknown): Page | null {
  const p = record as Page;
  if (
    !p ||
    typeof p.id !== "string" ||
    typeof p.workspaceId !== "string" ||
    typeof p.title !== "string" ||
    typeof p.position !== "number" ||
    (p.kind !== "document" && p.kind !== "group")
  ) {
    return null;
  }
  return {
    ...p,
    parentId: p.parentId ?? null,
    icon: p.icon ?? null,
    favoriteAt: typeof p.favoriteAt === "number" ? p.favoriteAt : null,
    lastOpenedAt: typeof p.lastOpenedAt === "number" ? p.lastOpenedAt : null,
    deletedAt: typeof p.deletedAt === "number" ? p.deletedAt : null,
  };
}

/** 与 normalizePage 同策略：id/name 非法则丢弃记录，其余字段补默认值。 */
function normalizeWorkspace(record: unknown): Workspace | null {
  const w = record as Workspace;
  if (!w || typeof w.id !== "string" || typeof w.name !== "string") return null;
  return {
    ...w,
    icon: w.icon ?? null,
    description: typeof w.description === "string" ? w.description : "",
    homePageId: w.homePageId ?? null,
    favoriteAt: typeof w.favoriteAt === "number" ? w.favoriteAt : null,
    lastOpenedAt: typeof w.lastOpenedAt === "number" ? w.lastOpenedAt : null,
  };
}

/**
 * 读取页面并要求其存在且完好；记录缺失或损坏时抛错。
 * 用于写路径（重命名、收藏等）——写操作不能接受降级跳过，必须显式失败。
 */
async function getRequiredPage(id: string): Promise<Page> {
  const db = await getDB();
  const page = normalizePage(await db.get(STORE_PAGES, id));
  if (!page) {
    throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
  }
  return page;
}

/**
 * 知识库仓储。除 `setLastOpened` 外，写操作在目标不存在/损坏时抛错；
 * `setLastOpened` 只是「最近打开」的打点，静默跳过以免干扰导航。
 */
export const workspaceRepository: WorkspaceRepository = {
  async list() {
    const db = await getDB();
    await ensureSeeded(db);
    const all = await db.getAll(STORE_WORKSPACES);
    return (all as unknown[])
      .map(normalizeWorkspace)
      .filter((w): w is Workspace => w !== null);
  },

  async create(name, extra) {
    const db = await getDB();
    const now = Date.now();
    const workspace: Workspace = {
      id: createId(),
      name,
      icon: extra?.icon ?? null,
      description: extra?.description ?? "",
      homePageId: null,
      favoriteAt: null,
      lastOpenedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.put(STORE_WORKSPACES, workspace);
    return workspace;
  },

  async rename(id, name) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) {
      throw new DomainError(
        "WORKSPACE_NOT_FOUND",
        `知识库不存在或数据损坏: ${id}`,
      );
    }
    await db.put(STORE_WORKSPACES, {
      ...workspace,
      name,
      updatedAt: Date.now(),
    });
  },

  async update(id, patch: UpdateWorkspaceInput) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) {
      throw new DomainError(
        "WORKSPACE_NOT_FOUND",
        `知识库不存在或数据损坏: ${id}`,
      );
    }
    await db.put(STORE_WORKSPACES, {
      ...workspace,
      ...patch,
      id,
      updatedAt: Date.now(),
    });
  },

  async setFavorite(id, favoriteAt) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) {
      throw new DomainError(
        "WORKSPACE_NOT_FOUND",
        `知识库不存在或数据损坏: ${id}`,
      );
    }
    await db.put(STORE_WORKSPACES, {
      ...workspace,
      favoriteAt,
      updatedAt: Date.now(),
    });
  },

  async setLastOpened(id, at) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) return;
    await db.put(STORE_WORKSPACES, { ...workspace, lastOpenedAt: at });
  },
};

/** 页面标题长度上限（字符）。 */
const MAX_PAGE_TITLE_LENGTH = 200;

/** 创建页面的入参校验（R003 阶段 4）：kind 合法、标题非空且不超长。 */
function validateCreatePageInput(input: CreatePageInput): void {
  if (input.kind !== "document" && input.kind !== "group") {
    throw new DomainError(
      "INVALID_INPUT",
      `非法页面类型: ${String(input.kind)}`,
    );
  }
  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_PAGE_TITLE_LENGTH) {
    throw new DomainError(
      "INVALID_INPUT",
      `页面标题长度须在 1～${MAX_PAGE_TITLE_LENGTH} 字符之间`,
    );
  }
}

/** 按键直取 + normalize 的页面读取；不存在或损坏返回 null。 */
async function getPage(db: IDBPDatabase, id: string): Promise<Page | null> {
  return normalizePage(await db.get(STORE_PAGES, id));
}

/** 工作区页面索引查询（R003 阶段 7）：替代 getAll 全表扫描。 */
async function listWorkspacePages(
  db: IDBPDatabase,
  workspaceId: string,
): Promise<Page[]> {
  const rows = (await db.getAllFromIndex(
    STORE_PAGES,
    "workspaceId",
    workspaceId,
  )) as unknown[];
  return rows.map(normalizePage).filter((p): p is Page => p !== null);
}

/**
 * 父级关系约束：父级必须存在、与被操作的页面同属一个知识库、未进回收站。
 * parent 为按键直取的记录；null 表示不存在或损坏。
 */
function assertValidParent(
  parent: Page | null,
  parentId: string,
  workspaceId: string,
): void {
  if (!parent) {
    throw new DomainError("PARENT_NOT_FOUND", `父页面不存在: ${parentId}`);
  }
  if (parent.workspaceId !== workspaceId) {
    throw new DomainError("CROSS_WORKSPACE_PARENT", "父页面属于其他知识库");
  }
  if (parent.deletedAt !== null) {
    throw new DomainError("PARENT_IN_TRASH", "父页面在回收站中，不能作为父级");
  }
}

/**
 * 页面仓储。树形操作（移动、软删、恢复、永久删除）都以整棵子树为单位，
 * 子树收集/成环检测/位置重排复用 `domain/pageTree.ts` 的纯函数，
 * 这里负责把结果在一个事务里落库。
 */
export const pageRepository: PageRepository = {
  async listByWorkspace(workspaceId) {
    const db = await getDB();
    await ensureSeeded(db);
    // 索引查询（R003 阶段 7）：只取本知识库页面，不再全表扫描；
    // 损坏数据降级不变：核心字段非法的记录跳过，缺失新字段补默认值。
    const rows = (await db.getAllFromIndex(
      STORE_PAGES,
      "workspaceId",
      workspaceId,
    )) as unknown[];
    return rows.map(normalizePage).filter((p): p is Page => p !== null);
  },

  async listAll() {
    const db = await getDB();
    await ensureSeeded(db);
    const all = (await db.getAll(STORE_PAGES)) as unknown[];
    return all.map(normalizePage).filter((p): p is Page => p !== null);
  },

  async create(input: CreatePageInput) {
    validateCreatePageInput(input);
    const db = await getDB();
    // 知识库必须存在（R003 阶段 4：页面关系约束）。
    const workspace = normalizeWorkspace(
      await db.get(STORE_WORKSPACES, input.workspaceId),
    );
    if (!workspace) {
      throw new DomainError(
        "WORKSPACE_NOT_FOUND",
        `知识库不存在或数据损坏: ${input.workspaceId}`,
      );
    }
    // 父级必须存在、同属本知识库、未删除（按键直取，不全扫）。
    if (input.parentId !== null) {
      const parent = normalizePage(await db.get(STORE_PAGES, input.parentId));
      assertValidParent(parent, input.parentId, input.workspaceId);
    }
    // 兄弟集合走 workspaceId 索引（R003 阶段 7），position 语义不变。
    const pages = await listWorkspacePages(db, input.workspaceId);
    const now = Date.now();
    // position 取同父级兄弟的下一个空位（追加到末尾），由 pageTree 纯函数计算。
    const page: Page = {
      id: createId(),
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: input.kind,
      title: input.title,
      icon: input.icon ?? null,
      position: nextPosition(pages, input.parentId),
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const tx = db.transaction([STORE_PAGES, STORE_CONTENTS], "readwrite");
    await tx.objectStore(STORE_PAGES).put(page);
    // 文档页同事务写入空正文，保证「有文档必有 contents 记录」这一不变量。
    if (page.kind === "document") {
      const content: DocumentContent = {
        pageId: page.id,
        workspaceId: page.workspaceId,
        contentJson: { type: "doc", content: [] },
        textSnapshot: "",
        // 新文档首版正文（R004 阶段 7）。
        version: 1,
        updatedAt: now,
      };
      await tx.objectStore(STORE_CONTENTS).put(content);
    }
    await tx.done;
    return page;
  },

  async rename(id, title) {
    const page = await getRequiredPage(id);
    const db = await getDB();
    await db.put(STORE_PAGES, { ...page, title, updatedAt: Date.now() });
  },

  async setFavorite(id, favoriteAt) {
    const page = await getRequiredPage(id);
    const db = await getDB();
    await db.put(STORE_PAGES, { ...page, favoriteAt, updatedAt: Date.now() });
  },

  async setLastOpened(id, at) {
    const page = await getRequiredPage(id);
    const db = await getDB();
    await db.put(STORE_PAGES, { ...page, lastOpenedAt: at });
  },

  async move(id, newParentId, index) {
    const db = await getDB();
    const page = await getPage(db, id);
    if (!page)
      throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
    // 新父级必须存在、同属本知识库、未删除（R003 阶段 4：页面关系约束）。
    if (newParentId !== null) {
      const parent = await getPage(db, newParentId);
      assertValidParent(parent, newParentId, page.workspaceId);
    }
    // 子树/环运算只需要本知识库页面（跨库父级已被禁止），走索引查询。
    const workspacePages = await listWorkspacePages(db, page.workspaceId);
    if (wouldCreateCycle(workspacePages, id, newParentId)) {
      throw new DomainError("PAGE_TREE_CYCLE", "不能移动到自身或其子页面下");
    }
    const targetIndex =
      index ??
      childrenOf(workspacePages, newParentId).filter((p) => p.id !== id).length;
    const next = movePage(workspacePages, id, newParentId, targetIndex);
    const now = Date.now();
    // movePage 会重排受影响兄弟的 position，但只有真正变化的行才回写，
    // 避免无关页面的 updatedAt 被刷新（会影响最近浏览等活动列表排序）。
    const changed = next.filter((p) => {
      const before = workspacePages.find((w) => w.id === p.id);
      return (
        before &&
        (before.parentId !== p.parentId || before.position !== p.position)
      );
    });
    const tx = db.transaction(STORE_PAGES, "readwrite");
    for (const p of changed) {
      await tx.store.put({ ...p, updatedAt: now });
    }
    await tx.done;
  },

  async remove(id) {
    const db = await getDB();
    const page = await getPage(db, id);
    if (!page)
      throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
    const all = await listWorkspacePages(db, page.workspaceId);
    const now = Date.now();
    const ids = collectSubtreeIds(all, id);
    const tx = db.transaction([STORE_PAGES, STORE_TRASH], "readwrite");
    for (const pageId of ids) {
      const target = all.find((p) => p.id === pageId);
      // 已在回收站的跳过：子树与祖先可能先后被删，避免覆盖首次删除时记录的 originalParentId。
      if (!target || target.deletedAt !== null) continue;
      await tx
        .objectStore(STORE_PAGES)
        .put({ ...target, deletedAt: now, updatedAt: now });
      await tx.objectStore(STORE_TRASH).put({
        pageId,
        deletedAt: now,
        originalParentId: target.parentId,
      });
    }
    await tx.done;
  },

  async restore(id) {
    const db = await getDB();
    const page = await getPage(db, id);
    if (!page)
      throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
    const all = await listWorkspacePages(db, page.workspaceId);
    const ids = collectSubtreeIds(all, id);
    const trash = (await db.getAll(STORE_TRASH)) as {
      pageId: string;
      originalParentId: string | null;
    }[];
    const trashedIds = new Set(trash.map((t) => t.pageId));
    const now = Date.now();
    const tx = db.transaction([STORE_PAGES, STORE_TRASH], "readwrite");
    for (const pageId of ids) {
      const target = all.find((p) => p.id === pageId);
      // 未删除的成员（例如子树中只有部分被删）原样保留，不参与恢复。
      if (!target || target.deletedAt === null) continue;
      const record = trash.find((t) => t.pageId === pageId);
      let parentId = record?.originalParentId ?? null;
      // 原父级已不存在或仍在回收站时回到根，避免恢复后不可见。
      const parent = parentId ? all.find((p) => p.id === parentId) : undefined;
      if (
        parentId &&
        (!parent || (trashedIds.has(parentId) && !ids.includes(parentId)))
      ) {
        parentId = null;
      }
      const siblings = all.filter(
        (p) => p.workspaceId === target.workspaceId && p.id !== target.id,
      );
      await tx.objectStore(STORE_PAGES).put({
        ...target,
        parentId,
        position: nextPosition(siblings, parentId),
        deletedAt: null,
        updatedAt: now,
      });
      await tx.objectStore(STORE_TRASH).delete(pageId);
    }
    await tx.done;
  },

  async purge(id) {
    const db = await getDB();
    const page = await getPage(db, id);
    if (!page)
      throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
    const ids = collectSubtreeIds(
      await listWorkspacePages(db, page.workspaceId),
      id,
    );
    const tx = db.transaction(
      [
        STORE_PAGES,
        STORE_CONTENTS,
        STORE_PAGE_TAGS,
        STORE_TRASH,
        STORE_REVISIONS,
        STORE_ATTACHMENTS,
      ],
      "readwrite",
    );
    await purgePagesInTx(tx, ids);
    await tx.done;
  },

  async purgeTrashed(workspaceId) {
    // 单事务清空（R003 阶段 7）：不再逐根页面循环 purge。
    const db = await getDB();
    const pages = await listWorkspacePages(db, workspaceId);
    const trashedIds = new Set(
      pages.filter((p) => p.deletedAt !== null).map((p) => p.id),
    );
    if (trashedIds.size === 0) return;
    // 已删子树的全集：软删以子树为单位写入，trashedIds 天然含后代；
    // 再用邻接表闭包兜底历史数据中的断裂子树。
    const ids = new Set<string>();
    for (const pageId of trashedIds) {
      for (const subId of collectSubtreeIds(pages, pageId)) ids.add(subId);
    }
    const tx = db.transaction(
      [
        STORE_PAGES,
        STORE_CONTENTS,
        STORE_PAGE_TAGS,
        STORE_TRASH,
        STORE_REVISIONS,
        STORE_ATTACHMENTS,
      ],
      "readwrite",
    );
    await purgePagesInTx(tx, [...ids]);
    await tx.done;
  },
};

/** 在一个事务内级联删除页面及其正文、标签关联、回收站记录、版本与附件。 */
async function purgePagesInTx(
  tx: IDBPTransaction<unknown, string[], "readwrite">,
  ids: string[],
): Promise<void> {
  for (const pageId of ids) {
    await tx.objectStore(STORE_PAGES).delete(pageId);
    await tx.objectStore(STORE_CONTENTS).delete(pageId);
    await tx.objectStore(STORE_TRASH).delete(pageId);
    const tagKeys = await tx
      .objectStore(STORE_PAGE_TAGS)
      .index("pageId")
      .getAllKeys(pageId);
    for (const key of tagKeys) {
      await tx.objectStore(STORE_PAGE_TAGS).delete(key);
    }
    // 级联：版本与附件随永久删除清理（回收站内保留以便恢复）。
    const revisionKeys = await tx
      .objectStore(STORE_REVISIONS)
      .index("pageId")
      .getAllKeys(pageId);
    for (const key of revisionKeys) {
      await tx.objectStore(STORE_REVISIONS).delete(key);
    }
    const attachmentKeys = await tx
      .objectStore(STORE_ATTACHMENTS)
      .index("pageId")
      .getAllKeys(pageId);
    for (const key of attachmentKeys) {
      await tx.objectStore(STORE_ATTACHMENTS).delete(key);
    }
  }
}

/**
 * 文档正文仓储。contents 以 pageId 为主键，与 pages 一一对应；
 * `contentJson` 是唯一编辑真相，`textSnapshot` 仅供搜索与 Markdown 导出（见 AGENTS.md 架构约束）。
 * R004 阶段 5：记录冗余 workspaceId，写路径一律从页面取（页面不存在抛 PAGE_NOT_FOUND），
 * 工作区查询走 `workspaceId` 索引，不再全表扫描。
 */
export const contentRepository: ContentRepository = {
  async get(pageId) {
    const db = await getDB();
    const content = (await db.get(STORE_CONTENTS, pageId)) as
      DocumentContent | undefined;
    // 损坏记录按「无正文」处理，由上层走空文档逻辑，而不是把脏 JSON 塞进编辑器。
    if (!content || typeof content.pageId !== "string") return undefined;
    return normalizeContent(content);
  },

  async save(pageId, contentJson, textSnapshot, expectedVersion) {
    const db = await getDB();
    // 单事务读页面取 workspaceId + 读当前正文 version 再写正文（R004 阶段 7
    // 乐观锁）：页面不存在抛 PAGE_NOT_FOUND；version 不匹配抛 DOCUMENT_CONFLICT，
    // 多标签页并发保存时后到者显式失败而不是静默覆盖。
    const tx = db.transaction([STORE_PAGES, STORE_CONTENTS], "readwrite");
    const page = normalizePage(await tx.objectStore(STORE_PAGES).get(pageId));
    if (!page) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        `页面不存在或数据损坏: ${pageId}`,
      );
    }
    const existing = (await tx.objectStore(STORE_CONTENTS).get(pageId)) as
      DocumentContent | undefined;
    // 存量记录无 version 字段：读路径视为 0（首次保存落 1），无需 schema 升级。
    const currentVersion =
      existing && typeof existing.version === "number" ? existing.version : 0;
    if (currentVersion !== expectedVersion) {
      throw new DomainError(
        "DOCUMENT_CONFLICT",
        `文档已在其他地方被修改（当前版本 ${currentVersion}，期望 ${expectedVersion}）`,
      );
    }
    const updatedAt = Date.now();
    const content: DocumentContent = {
      pageId,
      workspaceId: page.workspaceId,
      contentJson,
      textSnapshot,
      version: currentVersion + 1,
      updatedAt,
    };
    await tx.objectStore(STORE_CONTENTS).put(content);
    await tx.done;
    return { version: content.version, updatedAt };
  },

  async listAll() {
    const db = await getDB();
    const all = (await db.getAll(STORE_CONTENTS)) as unknown[];
    return all.filter(isValidContent).map(normalizeContent);
  },

  async listByWorkspace(workspaceId) {
    const db = await getDB();
    // 工作区索引直取（R004 阶段 5）：会话加载不再全表扫描正文。
    const rows = (await db.getAllFromIndex(
      STORE_CONTENTS,
      "workspaceId",
      workspaceId,
    )) as unknown[];
    return rows.filter(isValidContent).map(normalizeContent);
  },
};

/** 正文记录校验：核心字段非法的记录跳过（v4 迁移前的旧数据由迁移补齐 workspaceId）。 */
function isValidContent(c: unknown): c is DocumentContent {
  return (
    !!c &&
    typeof (c as DocumentContent).pageId === "string" &&
    typeof (c as DocumentContent).workspaceId === "string" &&
    typeof (c as DocumentContent).textSnapshot === "string"
  );
}

/** 版本号归一化：存量记录无 version 字段（R004 阶段 7 前），读路径一律视为 0。 */
function normalizeContent(content: DocumentContent): DocumentContent {
  return {
    ...content,
    version: typeof content.version === "number" ? content.version : 0,
  };
}

/**
 * 原子文档写仓储（R004 阶段 2，INV-04）：页面与初始正文在单个 IndexedDB
 * 事务中创建，校验失败或任一步写入失败时事务整体回滚，不留空文档；
 * 正文 JSON 一律经白名单校验（parseDocumentContent），拒绝则不写入。
 */
export const documentWriteRepository: DocumentWriteRepository = {
  async createWithContent(input) {
    validateCreatePageInput({
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: "document",
      title: input.title,
      icon: input.icon,
    });
    const parsed = parseDocumentContent(input.contentJson);
    if (!parsed.ok) {
      throw new DomainError(
        "CORRUPTED_DOCUMENT",
        "初始正文 JSON 未通过白名单校验",
      );
    }
    const db = await getDB();
    // 校验与写入同一事务：任一步失败整体回滚（INV-04）。
    const tx = db.transaction(
      [STORE_WORKSPACES, STORE_PAGES, STORE_CONTENTS],
      "readwrite",
    );
    const workspace = normalizeWorkspace(
      await tx.objectStore(STORE_WORKSPACES).get(input.workspaceId),
    );
    if (!workspace) {
      throw new DomainError(
        "WORKSPACE_NOT_FOUND",
        `知识库不存在或数据损坏: ${input.workspaceId}`,
      );
    }
    if (input.parentId !== null) {
      const parent = normalizePage(
        await tx.objectStore(STORE_PAGES).get(input.parentId),
      );
      assertValidParent(parent, input.parentId, input.workspaceId);
    }
    const rows = (await tx
      .objectStore(STORE_PAGES)
      .index("workspaceId")
      .getAll(input.workspaceId)) as unknown[];
    const pages = rows.map(normalizePage).filter((p): p is Page => p !== null);
    const now = Date.now();
    const page: Page = {
      id: createId(),
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: "document",
      title: input.title,
      icon: input.icon ?? null,
      position: nextPosition(pages, input.parentId),
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.objectStore(STORE_PAGES).put(page);
    const content: DocumentContent = {
      pageId: page.id,
      workspaceId: page.workspaceId,
      contentJson: parsed.value,
      textSnapshot: input.textSnapshot,
      // 新文档首版正文（R004 阶段 7）。
      version: 1,
      updatedAt: now,
    };
    await tx.objectStore(STORE_CONTENTS).put(content);
    await tx.done;
    return page;
  },

  async replaceContent(input) {
    const parsed = parseDocumentContent(input.contentJson);
    if (!parsed.ok) {
      throw new DomainError("CORRUPTED_DOCUMENT", "正文 JSON 未通过白名单校验");
    }
    const db = await getDB();
    const tx = db.transaction([STORE_PAGES, STORE_CONTENTS], "readwrite");
    const page = normalizePage(
      await tx.objectStore(STORE_PAGES).get(input.pageId),
    );
    if (!page) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        `页面不存在或数据损坏: ${input.pageId}`,
      );
    }
    const existing = (await tx
      .objectStore(STORE_CONTENTS)
      .get(input.pageId)) as DocumentContent | undefined;
    // 外部覆盖路径（导入/模板/损坏面板）：不做冲突检查，但 version 照常递增，
    // 保证编辑器保存链路的乐观锁读到的是单调递增版本（R004 阶段 7）。
    const currentVersion =
      existing && typeof existing.version === "number" ? existing.version : 0;
    const content: DocumentContent = {
      pageId: input.pageId,
      workspaceId: page.workspaceId,
      contentJson: parsed.value,
      textSnapshot: input.textSnapshot,
      version: currentVersion + 1,
      updatedAt: Date.now(),
    };
    await tx.objectStore(STORE_CONTENTS).put(content);
    await tx.done;
    return content;
  },
};

function isValidRevision(record: unknown): record is DocumentRevision {
  const r = record as DocumentRevision;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.pageId === "string" &&
    typeof r.createdAt === "number" &&
    (r.reason === "interval" ||
      r.reason === "before-restore" ||
      r.reason === "manual")
  );
}

/** 稳定内容键：相邻版本内容一致时用于去重。 */
function revisionContentKey(contentJson: unknown): string {
  return JSON.stringify(contentJson ?? null);
}

/**
 * 版本历史仓储（R001 §8.3）。版本按 pageId 索引存储；
 * 自动（interval）版本有数量上限并由 `pruneInterval` 清理，手动与恢复前版本永久保留。
 */
export const revisionRepository: RevisionRepository = {
  async listByPage(pageId) {
    const db = await getDB();
    const all = (await db.getAllFromIndex(
      STORE_REVISIONS,
      "pageId",
      pageId,
    )) as unknown[];
    // 损坏记录跳过，其余按创建时间倒序。
    return all
      .filter(isValidRevision)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async add(pageId, contentJson, textSnapshot, reason: RevisionReason) {
    const db = await getDB();
    // 与最新版本内容一致时不重复落库：防抖保存与间隔自动版本可能在没有实际编辑时触发。
    const latest = (await revisionRepository.listByPage(pageId))[0];
    if (
      latest &&
      revisionContentKey(latest.contentJson) === revisionContentKey(contentJson)
    ) {
      return null;
    }
    const revision: DocumentRevision = {
      id: createId(),
      pageId,
      contentJson,
      textSnapshot,
      createdAt: Date.now(),
      reason,
    };
    await db.put(STORE_REVISIONS, revision);
    return revision;
  },

  async pruneInterval(pageId, keep, maxBytes) {
    const db = await getDB();
    const interval = (await revisionRepository.listByPage(pageId)).filter(
      (r) => r.reason === "interval",
    );
    // 数量与总字节双重预算（R004 阶段 6）：裁剪规则集中在 domain/revisions，
    // 保证两实现语义一致且可确定性测试。
    const excess = selectRevisionsToPrune(
      interval.map((r) => ({
        ...r,
        bytes: revisionContentBytes(r.contentJson),
      })),
      keep,
      maxBytes ?? Number.POSITIVE_INFINITY,
    );
    if (excess.length === 0) return;
    const tx = db.transaction(STORE_REVISIONS, "readwrite");
    for (const r of excess) {
      await tx.store.delete(r.id);
    }
    await tx.done;
  },
};

function isValidAttachment(record: unknown): record is Attachment {
  const a = record as Attachment;
  return (
    !!a &&
    typeof a.id === "string" &&
    typeof a.pageId === "string" &&
    typeof a.name === "string" &&
    typeof a.mimeType === "string" &&
    typeof a.size === "number"
  );
}

/**
 * 附件仓储（R001 §7.6）。Blob 直接存 IndexedDB，随页面 purge 级联删除；
 * `removeOrphans` 在保存后清理文档不再引用的附件，防止存储只增不减。
 */
export const attachmentRepository: AttachmentRepository = {
  async get(id) {
    const db = await getDB();
    const record = await db.get(STORE_ATTACHMENTS, id);
    return isValidAttachment(record) ? record : undefined;
  },

  async listByPage(pageId) {
    const db = await getDB();
    const all = (await db.getAllFromIndex(
      STORE_ATTACHMENTS,
      "pageId",
      pageId,
    )) as unknown[];
    return all.filter(isValidAttachment);
  },

  async add(input: CreateAttachmentInput) {
    const db = await getDB();
    const attachment: Attachment = {
      id: createId(),
      pageId: input.pageId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      blob: input.blob,
      createdAt: Date.now(),
    };
    await db.put(STORE_ATTACHMENTS, attachment);
    return attachment;
  },

  async remove(id) {
    const db = await getDB();
    await db.delete(STORE_ATTACHMENTS, id);
  },

  async removeOrphans(pageId, referencedIds, options) {
    const referenced = new Set(referencedIds);
    const cutoff = options?.createdBeforeOrAt;
    const all = await attachmentRepository.listByPage(pageId);
    // 只清理快照产生之前已存在的孤儿：快照之后新建的附件可能尚未进入
    // 新正文快照，删除会误伤（R004 INV-03）。
    const orphans = all.filter(
      (a) =>
        !referenced.has(a.id) &&
        (cutoff === undefined || a.createdAt <= cutoff),
    );
    if (orphans.length === 0) return 0;
    const db = await getDB();
    const tx = db.transaction(STORE_ATTACHMENTS, "readwrite");
    for (const a of orphans) {
      await tx.store.delete(a.id);
    }
    await tx.done;
    return orphans.length;
  },
};

function isValidTag(record: unknown): record is Tag {
  const t = record as Tag;
  return (
    !!t &&
    typeof t.id === "string" &&
    typeof t.workspaceId === "string" &&
    typeof t.name === "string" &&
    typeof t.color === "string"
  );
}

/**
 * 标签仓储。标签与页面的关联存放在独立的 pageTags store（复合主键 [pageId, tagId]），
 * 删除标签或覆盖页面标签时都需同步维护该 store。
 */
export const tagRepository: TagRepository = {
  async listByWorkspace(workspaceId) {
    const db = await getDB();
    // 索引查询（R003 阶段 7）：只取本知识库标签，不再全表扫描。
    const rows = (await db.getAllFromIndex(
      STORE_TAGS,
      "workspaceId",
      workspaceId,
    )) as unknown[];
    return rows.filter(isValidTag);
  },

  async create(workspaceId, name, color) {
    const db = await getDB();
    const tag: Tag = { id: createId(), workspaceId, name, color };
    await db.put(STORE_TAGS, tag);
    return tag;
  },

  async remove(id) {
    const db = await getDB();
    const tx = db.transaction([STORE_TAGS, STORE_PAGE_TAGS], "readwrite");
    await tx.objectStore(STORE_TAGS).delete(id);
    const keys = await tx
      .objectStore(STORE_PAGE_TAGS)
      .index("tagId")
      .getAllKeys(id);
    for (const key of keys) {
      await tx.objectStore(STORE_PAGE_TAGS).delete(key);
    }
    await tx.done;
  },

  async listPageTagIds(pageId) {
    const db = await getDB();
    const rows = (await db.getAllFromIndex(
      STORE_PAGE_TAGS,
      "pageId",
      pageId,
    )) as {
      tagId: string;
    }[];
    return rows.map((r) => r.tagId);
  },

  async listWorkspacePageTags(workspaceId) {
    const db = await getDB();
    // 工作区索引直取（R004 阶段 5）：不再全表扫描 + 按页面集合内存过滤。
    const rows = (await db.getAllFromIndex(
      STORE_PAGE_TAGS,
      "workspaceId",
      workspaceId,
    )) as PageTag[];
    return rows.filter(
      (r) => r && typeof r.pageId === "string" && typeof r.tagId === "string",
    );
  },

  async setPageTags(pageId, tagIds) {
    const db = await getDB();
    // 关系约束（R003 阶段 4）：页面存在、标签存在且与页面同属一个知识库。
    const page = normalizePage(await db.get(STORE_PAGES, pageId));
    if (!page) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        `页面不存在或数据损坏: ${pageId}`,
      );
    }
    const uniqueTagIds = [...new Set(tagIds)];
    for (const tagId of uniqueTagIds) {
      const tag = await db.get(STORE_TAGS, tagId);
      if (!isValidTag(tag)) {
        throw new DomainError(
          "TAG_NOT_FOUND",
          `标签不存在或数据损坏: ${tagId}`,
        );
      }
      if (tag.workspaceId !== page.workspaceId) {
        throw new DomainError(
          "CROSS_WORKSPACE_TAG",
          "标签与页面属于不同知识库，不能绑定",
        );
      }
    }
    const tx = db.transaction(STORE_PAGE_TAGS, "readwrite");
    // 覆盖式语义：先清后写；入参已去重避免复合主键冲突。
    const existing = await tx.store.index("pageId").getAllKeys(pageId);
    for (const key of existing) {
      await tx.store.delete(key);
    }
    for (const tagId of uniqueTagIds) {
      await tx.store.put({ pageId, tagId, workspaceId: page.workspaceId });
    }
    await tx.done;
  },
};

/**
 * 偏好记录校验与默认值回退：旧版本或损坏数据不会污染运行时配置。
 * get 与 update 共用，保证两条路径的校验规则一致。
 */
function normalizePreferences(stored: unknown): Preferences {
  // 损坏或缺失时回退默认值。
  if (!stored || typeof stored !== "object") return DEFAULT_PREFERENCES;
  const partial = stored as Partial<Preferences>;
  // aiConfig 形状校验：三个字段均为字符串才保留，否则回退 null。
  const ai = partial.aiConfig;
  const aiConfig =
    ai !== null &&
    typeof ai === "object" &&
    typeof ai.endpoint === "string" &&
    typeof ai.model === "string" &&
    typeof ai.apiKey === "string"
      ? { endpoint: ai.endpoint, model: ai.model, apiKey: ai.apiKey }
      : null;
  return {
    ...DEFAULT_PREFERENCES,
    ...partial,
    id: "preferences",
    theme: partial.theme === "dark" ? "dark" : "light",
    aiConfig,
    lastRoute: typeof partial.lastRoute === "string" ? partial.lastRoute : null,
  };
}

/**
 * 偏好设置仓储。整库只有一条固定 id 为 "preferences" 的记录；
 * 读取时逐字段校验并回退默认值，保证旧版本或损坏数据不会污染运行时配置。
 * 注意 aiConfig 含 API Key，仅存于本地 IndexedDB，不进入日志与上报（见 AGENTS.md 安全约定）。
 */
export const preferencesRepository: PreferencesRepository = {
  async get() {
    const db = await getDB();
    const stored = await db.get(STORE_PREFERENCES, "preferences");
    return normalizePreferences(stored);
  },

  async update(patch) {
    // 读-改-写放在同一 readwrite 事务内（R003 阶段 3）：
    // 并发 update 不再各自读取过期基线后互相覆盖。
    const db = await getDB();
    const tx = db.transaction(STORE_PREFERENCES, "readwrite");
    const stored = await tx.store.get("preferences");
    const current = normalizePreferences(stored);
    const next: Preferences = { ...current, ...patch, id: "preferences" };
    await tx.store.put(next);
    await tx.done;
    return next;
  },
};
