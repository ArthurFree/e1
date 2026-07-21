import type {
  AttachmentRepository,
  ContentRepository,
  CreateAttachmentInput,
  CreatePageInput,
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
import { ensureSeeded } from "./seed";
import { createId } from "./id";

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

async function getRequiredPage(id: string): Promise<Page> {
  const db = await getDB();
  const page = normalizePage(await db.get(STORE_PAGES, id));
  if (!page) {
    throw new Error(`页面不存在或数据损坏: ${id}`);
  }
  return page;
}

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
      throw new Error(`知识库不存在或数据损坏: ${id}`);
    }
    await db.put(STORE_WORKSPACES, { ...workspace, name, updatedAt: Date.now() });
  },

  async update(id, patch: UpdateWorkspaceInput) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) {
      throw new Error(`知识库不存在或数据损坏: ${id}`);
    }
    await db.put(STORE_WORKSPACES, { ...workspace, ...patch, id, updatedAt: Date.now() });
  },

  async setFavorite(id, favoriteAt) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) {
      throw new Error(`知识库不存在或数据损坏: ${id}`);
    }
    await db.put(STORE_WORKSPACES, { ...workspace, favoriteAt, updatedAt: Date.now() });
  },

  async setLastOpened(id, at) {
    const db = await getDB();
    const workspace = normalizeWorkspace(await db.get(STORE_WORKSPACES, id));
    if (!workspace) return;
    await db.put(STORE_WORKSPACES, { ...workspace, lastOpenedAt: at });
  },
};

export const pageRepository: PageRepository = {
  async listByWorkspace(workspaceId) {
    const db = await getDB();
    await ensureSeeded(db);
    const all = (await db.getAll(STORE_PAGES)) as unknown[];
    // 损坏数据降级：核心字段非法的记录跳过，缺失新字段补默认值。
    return all
      .map(normalizePage)
      .filter((p): p is Page => p !== null && p.workspaceId === workspaceId);
  },

  async listAll() {
    const db = await getDB();
    await ensureSeeded(db);
    const all = (await db.getAll(STORE_PAGES)) as unknown[];
    return all.map(normalizePage).filter((p): p is Page => p !== null);
  },

  async create(input: CreatePageInput) {
    const db = await getDB();
    const siblings = (await db.getAll(STORE_PAGES)) as unknown[];
    const pages = siblings
      .map(normalizePage)
      .filter((p): p is Page => p !== null && p.workspaceId === input.workspaceId);
    const now = Date.now();
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
    if (page.kind === "document") {
      const content: DocumentContent = {
        pageId: page.id,
        contentJson: { type: "doc", content: [] },
        textSnapshot: "",
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
    const all = ((await db.getAll(STORE_PAGES)) as unknown[])
      .map(normalizePage)
      .filter((p): p is Page => p !== null);
    const page = all.find((p) => p.id === id);
    if (!page) throw new Error(`页面不存在或数据损坏: ${id}`);
    if (wouldCreateCycle(all, id, newParentId)) {
      throw new Error("不能移动到自身或其子页面下");
    }
    const workspacePages = all.filter((p) => p.workspaceId === page.workspaceId);
    const targetIndex =
      index ?? childrenOf(workspacePages, newParentId).filter((p) => p.id !== id).length;
    const next = movePage(workspacePages, id, newParentId, targetIndex);
    const now = Date.now();
    const changed = next.filter((p) => {
      const before = workspacePages.find((w) => w.id === p.id);
      return before && (before.parentId !== p.parentId || before.position !== p.position);
    });
    const tx = db.transaction(STORE_PAGES, "readwrite");
    for (const p of changed) {
      await tx.store.put({ ...p, updatedAt: now });
    }
    await tx.done;
  },

  async remove(id) {
    const db = await getDB();
    const all = ((await db.getAll(STORE_PAGES)) as unknown[])
      .map(normalizePage)
      .filter((p): p is Page => p !== null);
    const page = all.find((p) => p.id === id);
    if (!page) throw new Error(`页面不存在或数据损坏: ${id}`);
    const now = Date.now();
    const ids = collectSubtreeIds(all, id);
    const tx = db.transaction([STORE_PAGES, STORE_TRASH], "readwrite");
    for (const pageId of ids) {
      const target = all.find((p) => p.id === pageId);
      if (!target || target.deletedAt !== null) continue;
      await tx.objectStore(STORE_PAGES).put({ ...target, deletedAt: now, updatedAt: now });
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
    const all = ((await db.getAll(STORE_PAGES)) as unknown[])
      .map(normalizePage)
      .filter((p): p is Page => p !== null);
    const page = all.find((p) => p.id === id);
    if (!page) throw new Error(`页面不存在或数据损坏: ${id}`);
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
      if (!target || target.deletedAt === null) continue;
      const record = trash.find((t) => t.pageId === pageId);
      let parentId = record?.originalParentId ?? null;
      // 原父级已不存在或仍在回收站时回到根，避免恢复后不可见。
      const parent = parentId ? all.find((p) => p.id === parentId) : undefined;
      if (parentId && (!parent || (trashedIds.has(parentId) && !ids.includes(parentId)))) {
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
    const all = ((await db.getAll(STORE_PAGES)) as unknown[])
      .map(normalizePage)
      .filter((p): p is Page => p !== null);
    const page = all.find((p) => p.id === id);
    if (!page) throw new Error(`页面不存在或数据损坏: ${id}`);
    const ids = collectSubtreeIds(all, id);
    const tx = db.transaction(
      [STORE_PAGES, STORE_CONTENTS, STORE_PAGE_TAGS, STORE_TRASH, STORE_REVISIONS, STORE_ATTACHMENTS],
      "readwrite",
    );
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
    await tx.done;
  },

  async purgeTrashed(workspaceId) {
    const pages = await pageRepository.listByWorkspace(workspaceId);
    const trashed = pages.filter((p) => p.deletedAt !== null);
    const trashedIds = new Set(trashed.map((p) => p.id));
    // 只从回收站的“根”开始清，避免同一子树被重复 purge。
    const roots = trashed.filter(
      (p) => p.parentId === null || !trashedIds.has(p.parentId),
    );
    for (const root of roots) {
      await pageRepository.purge(root.id);
    }
  },
};

export const contentRepository: ContentRepository = {
  async get(pageId) {
    const db = await getDB();
    const content = (await db.get(STORE_CONTENTS, pageId)) as DocumentContent | undefined;
    if (!content || typeof content.pageId !== "string") return undefined;
    return content;
  },

  async save(pageId, contentJson, textSnapshot) {
    const db = await getDB();
    const content: DocumentContent = {
      pageId,
      contentJson,
      textSnapshot,
      updatedAt: Date.now(),
    };
    await db.put(STORE_CONTENTS, content);
  },

  async listAll() {
    const db = await getDB();
    const all = (await db.getAll(STORE_CONTENTS)) as unknown[];
    return all.filter(
      (c): c is DocumentContent =>
        !!c &&
        typeof (c as DocumentContent).pageId === "string" &&
        typeof (c as DocumentContent).textSnapshot === "string",
    );
  },
};

function isValidRevision(record: unknown): record is DocumentRevision {
  const r = record as DocumentRevision;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.pageId === "string" &&
    typeof r.createdAt === "number" &&
    (r.reason === "interval" || r.reason === "before-restore" || r.reason === "manual")
  );
}

/** 稳定内容键：相邻版本内容一致时用于去重。 */
function revisionContentKey(contentJson: unknown): string {
  return JSON.stringify(contentJson ?? null);
}

export const revisionRepository: RevisionRepository = {
  async listByPage(pageId) {
    const db = await getDB();
    const all = (await db.getAllFromIndex(STORE_REVISIONS, "pageId", pageId)) as unknown[];
    // 损坏记录跳过，其余按创建时间倒序。
    return all.filter(isValidRevision).sort((a, b) => b.createdAt - a.createdAt);
  },

  async add(pageId, contentJson, textSnapshot, reason: RevisionReason) {
    const db = await getDB();
    const latest = (await revisionRepository.listByPage(pageId))[0];
    if (latest && revisionContentKey(latest.contentJson) === revisionContentKey(contentJson)) {
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

  async pruneInterval(pageId, keep) {
    const db = await getDB();
    const interval = (await revisionRepository.listByPage(pageId)).filter(
      (r) => r.reason === "interval",
    );
    const excess = interval.slice(keep);
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

export const attachmentRepository: AttachmentRepository = {
  async get(id) {
    const db = await getDB();
    const record = await db.get(STORE_ATTACHMENTS, id);
    return isValidAttachment(record) ? record : undefined;
  },

  async listByPage(pageId) {
    const db = await getDB();
    const all = (await db.getAllFromIndex(STORE_ATTACHMENTS, "pageId", pageId)) as unknown[];
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

  async removeOrphans(pageId, referencedIds) {
    const referenced = new Set(referencedIds);
    const all = await attachmentRepository.listByPage(pageId);
    const orphans = all.filter((a) => !referenced.has(a.id));
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

export const tagRepository: TagRepository = {
  async listByWorkspace(workspaceId) {
    const db = await getDB();
    const all = (await db.getAll(STORE_TAGS)) as unknown[];
    return all.filter(
      (t): t is Tag => isValidTag(t) && t.workspaceId === workspaceId,
    );
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
    const keys = await tx.objectStore(STORE_PAGE_TAGS).index("tagId").getAllKeys(id);
    for (const key of keys) {
      await tx.objectStore(STORE_PAGE_TAGS).delete(key);
    }
    await tx.done;
  },

  async listPageTagIds(pageId) {
    const db = await getDB();
    const rows = (await db.getAllFromIndex(STORE_PAGE_TAGS, "pageId", pageId)) as {
      tagId: string;
    }[];
    return rows.map((r) => r.tagId);
  },

  async listWorkspacePageTags(workspaceId) {
    const db = await getDB();
    const pageIds = new Set(
      ((await db.getAll(STORE_PAGES)) as unknown[])
        .map(normalizePage)
        .filter((p): p is Page => p !== null && p.workspaceId === workspaceId)
        .map((p) => p.id),
    );
    const rows = (await db.getAll(STORE_PAGE_TAGS)) as PageTag[];
    return rows.filter(
      (r) => r && typeof r.pageId === "string" && pageIds.has(r.pageId),
    );
  },

  async setPageTags(pageId, tagIds) {
    const db = await getDB();
    const tx = db.transaction(STORE_PAGE_TAGS, "readwrite");
    const existing = await tx.store.index("pageId").getAllKeys(pageId);
    for (const key of existing) {
      await tx.store.delete(key);
    }
    for (const tagId of new Set(tagIds)) {
      await tx.store.put({ pageId, tagId });
    }
    await tx.done;
  },
};

export const preferencesRepository: PreferencesRepository = {
  async get() {
    const db = await getDB();
    const stored = (await db.get(STORE_PREFERENCES, "preferences")) as
      | Partial<Preferences>
      | undefined;
    // 损坏或缺失时回退默认值。
    if (!stored || typeof stored !== "object") return DEFAULT_PREFERENCES;
    // aiConfig 形状校验：三个字段均为字符串才保留，否则回退 null。
    const ai = stored.aiConfig;
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
      ...stored,
      id: "preferences",
      theme: stored.theme === "dark" ? "dark" : "light",
      aiConfig,
      lastRoute: typeof stored.lastRoute === "string" ? stored.lastRoute : null,
    };
  },

  async update(patch) {
    const current = await preferencesRepository.get();
    const next: Preferences = { ...current, ...patch, id: "preferences" };
    const db = await getDB();
    await db.put(STORE_PREFERENCES, next);
    return next;
  },
};
