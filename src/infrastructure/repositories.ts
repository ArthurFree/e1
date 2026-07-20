import type {
  ContentRepository,
  CreatePageInput,
  PageRepository,
  PreferencesRepository,
  WorkspaceRepository,
} from "../domain/repositories";
import {
  collectSubtreeIds,
  nextPosition,
  wouldCreateCycle,
} from "../domain/pageTree";
import {
  DEFAULT_PREFERENCES,
  type DocumentContent,
  type Page,
  type Preferences,
  type Workspace,
} from "../domain/types";
import { getDB, STORE_CONTENTS, STORE_PAGES, STORE_PREFERENCES, STORE_TRASH, STORE_WORKSPACES } from "./db";
import { ensureSeeded } from "./seed";
import { createId } from "./id";

function isValidPage(record: unknown): record is Page {
  const p = record as Page;
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.workspaceId === "string" &&
    typeof p.title === "string" &&
    typeof p.position === "number" &&
    (p.kind === "document" || p.kind === "folder")
  );
}

function isValidWorkspace(record: unknown): record is Workspace {
  const w = record as Workspace;
  return !!w && typeof w.id === "string" && typeof w.name === "string";
}

async function getRequiredPage(id: string): Promise<Page> {
  const db = await getDB();
  const page = await db.get(STORE_PAGES, id);
  if (!isValidPage(page)) {
    throw new Error(`页面不存在或数据损坏: ${id}`);
  }
  return page;
}

export const workspaceRepository: WorkspaceRepository = {
  async list() {
    const db = await getDB();
    await ensureSeeded(db);
    const all = await db.getAll(STORE_WORKSPACES);
    return (all as unknown[]).filter(isValidWorkspace);
  },

  async create(name) {
    const db = await getDB();
    const now = Date.now();
    const workspace: Workspace = {
      id: createId(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    await db.put(STORE_WORKSPACES, workspace);
    return workspace;
  },

  async rename(id, name) {
    const db = await getDB();
    const workspace = await db.get(STORE_WORKSPACES, id);
    if (!isValidWorkspace(workspace)) {
      throw new Error(`知识库不存在或数据损坏: ${id}`);
    }
    await db.put(STORE_WORKSPACES, { ...workspace, name, updatedAt: Date.now() });
  },
};

export const pageRepository: PageRepository = {
  async listByWorkspace(workspaceId) {
    const db = await getDB();
    await ensureSeeded(db);
    // 损坏数据降级：跳过字段缺失的记录而不是抛错。
    const all = (await db.getAll(STORE_PAGES)) as unknown[];
    return all.filter(
      (p): p is Page => isValidPage(p) && p.workspaceId === workspaceId,
    );
  },

  async create(input: CreatePageInput) {
    const db = await getDB();
    const siblings = (await db.getAll(STORE_PAGES)) as unknown[];
    const pages = siblings.filter(
      (p): p is Page => isValidPage(p) && p.workspaceId === input.workspaceId,
    );
    const now = Date.now();
    const page: Page = {
      id: createId(),
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: input.kind,
      title: input.title,
      icon: input.icon ?? null,
      position: nextPosition(pages, input.parentId),
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

  async move(id, newParentId) {
    const db = await getDB();
    const all = ((await db.getAll(STORE_PAGES)) as unknown[]).filter(isValidPage);
    const page = all.find((p) => p.id === id);
    if (!page) throw new Error(`页面不存在或数据损坏: ${id}`);
    if (wouldCreateCycle(all, id, newParentId)) {
      throw new Error("不能移动到自身或其子页面下");
    }
    const workspacePages = all.filter((p) => p.workspaceId === page.workspaceId);
    await db.put(STORE_PAGES, {
      ...page,
      parentId: newParentId,
      position: nextPosition(workspacePages, newParentId),
      updatedAt: Date.now(),
    });
  },

  async remove(id) {
    const db = await getDB();
    const all = ((await db.getAll(STORE_PAGES)) as unknown[]).filter(isValidPage);
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
    const all = ((await db.getAll(STORE_PAGES)) as unknown[]).filter(isValidPage);
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
};

export const preferencesRepository: PreferencesRepository = {
  async get() {
    const db = await getDB();
    const stored = (await db.get(STORE_PREFERENCES, "preferences")) as
      | Partial<Preferences>
      | undefined;
    // 损坏或缺失时回退默认值。
    if (!stored || typeof stored !== "object") return DEFAULT_PREFERENCES;
    return {
      ...DEFAULT_PREFERENCES,
      ...stored,
      id: "preferences",
      theme: stored.theme === "dark" ? "dark" : "light",
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
