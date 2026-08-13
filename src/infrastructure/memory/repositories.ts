/**
 * 内存仓储（R003 阶段 5）：7 个仓储 port 的纯内存实现。
 *
 * 用途：
 * - 证明 IndexedDB 仓储可整体替换（AppProvider 与组件可脱离 IndexedDB 运行）；
 * - 为未来其他存储后端提供实现参照。
 *
 * 语义与 IndexedDB 实现对齐：页面树操作复用 domain/pageTree 纯函数，
 * 软删/恢复/purge 级联、版本去重、R003 阶段 4 的关系约束与 DomainError
 * 全部保持一致；差异仅在不持久化（无 seed、无跨会话恢复）。
 */
import { DomainError } from "../../domain/errors";
import {
  revisionContentBytes,
  selectRevisionsToPrune,
} from "../../domain/revisions";
import { parseDocumentContent } from "../../domain/validation/documentContent";
import {
  childrenOf,
  collectSubtreeIds,
  movePage,
  nextPosition,
  wouldCreateCycle,
} from "../../domain/pageTree";
import type {
  AssetStore,
  ContentRepository,
  CreatePageInput,
  DocumentWriteRepository,
  PageRepository,
  PreferencesRepository,
  RevisionRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import { requireAttachmentBytes } from "../../domain/repositories";
import type {
  Attachment,
  ContentVersionToken,
  DocumentContent,
  DocumentRevision,
  Page,
  PageTag,
  Preferences,
  Tag,
  TrashRecord,
  Workspace,
} from "../../domain/types";
import {
  DEFAULT_PREFERENCES,
  INITIAL_CONTENT_VERSION_TOKEN,
} from "../../domain/types";
import { createId } from "../id";

const MAX_PAGE_TITLE_LENGTH = 200;

/**
 * 正文版本令牌（R005 阶段 3）：内存实现内部同样自增 number，读写边界
 * 映射为 "mem:N" 令牌；INITIAL_CONTENT_VERSION_TOKEN（空串）映射为内部
 * 初始版本 0；非 "mem:N" 编码的令牌一律视为冲突（DOCUMENT_CONFLICT）。
 * 契约（src/test/contentSaveContract.ts）不假设令牌可解析为数字。
 */
export type StoredMemoryContent = Omit<DocumentContent, "version"> & {
  version?: number;
};

/** 内部 number → 领域令牌（"mem:N"）。 */
function versionToToken(version: number): ContentVersionToken {
  return `mem:${version}`;
}

/** 领域令牌 → 内部 number；空令牌为初始版本 0，非本实现编码返回 null（视为冲突）。 */
function tokenToVersion(token: ContentVersionToken): number | null {
  if (token === INITIAL_CONTENT_VERSION_TOKEN) return 0;
  if (!token.startsWith("mem:")) return null;
  const n = Number(token.slice(4));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 读边界归一化：内部 number → 令牌；存量无 version 记录视为初始版本 0。 */
function toDomainContent(record: StoredMemoryContent): DocumentContent {
  return { ...record, version: versionToToken(record.version ?? 0) };
}

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

/** 内存附件记录：元数据 + 字节（与 IndexedDB 实现的 StoredAttachmentRecord 对应）。 */
export type StoredMemoryAttachment = Attachment & { data: Uint8Array };

/** 内存数据库：一次 createInMemoryRepositories 调用的全部仓储共享同一份数据。 */
export interface MemoryStore {
  workspaces: Map<string, Workspace>;
  pages: Map<string, Page>;
  contents: Map<string, StoredMemoryContent>;
  revisions: Map<string, DocumentRevision>;
  attachments: Map<string, StoredMemoryAttachment>;
  tags: Map<string, Tag>;
  pageTags: Map<string, PageTag>;
  trash: Map<string, TrashRecord>;
  preferences: Preferences;
}

export function createMemoryStore(): MemoryStore {
  return {
    workspaces: new Map(),
    pages: new Map(),
    contents: new Map(),
    revisions: new Map(),
    attachments: new Map(),
    tags: new Map(),
    pageTags: new Map(),
    trash: new Map(),
    preferences: { ...DEFAULT_PREFERENCES },
  };
}

export interface MemoryRepositories {
  workspace: WorkspaceRepository;
  page: PageRepository;
  content: ContentRepository;
  documentWrite: DocumentWriteRepository;
  revision: RevisionRepository;
  assetStore: AssetStore;
  tag: TagRepository;
  preferences: PreferencesRepository;
}

/** 基于共享内存数据创建全套仓储实现。 */
export function createInMemoryRepositories(
  store: MemoryStore = createMemoryStore(),
): MemoryRepositories {
  const allPages = () => [...store.pages.values()];

  function getRequiredPage(id: string): Page {
    const page = store.pages.get(id);
    if (!page) {
      throw new DomainError("PAGE_NOT_FOUND", `页面不存在或数据损坏: ${id}`);
    }
    return page;
  }

  function assertValidParent(parentId: string, workspaceId: string): void {
    const parent = store.pages.get(parentId);
    if (!parent) {
      throw new DomainError("PARENT_NOT_FOUND", `父页面不存在: ${parentId}`);
    }
    if (parent.workspaceId !== workspaceId) {
      throw new DomainError("CROSS_WORKSPACE_PARENT", "父页面属于其他知识库");
    }
    if (parent.deletedAt !== null) {
      throw new DomainError(
        "PARENT_IN_TRASH",
        "父页面在回收站中，不能作为父级",
      );
    }
  }

  const workspace: WorkspaceRepository = {
    async list() {
      return [...store.workspaces.values()];
    },
    async create(name, extra) {
      const now = Date.now();
      const ws: Workspace = {
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
      store.workspaces.set(ws.id, ws);
      return ws;
    },
    async rename(id, name) {
      const ws = store.workspaces.get(id);
      if (!ws) {
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          `知识库不存在或数据损坏: ${id}`,
        );
      }
      store.workspaces.set(id, { ...ws, name, updatedAt: Date.now() });
    },
    async update(id, patch) {
      const ws = store.workspaces.get(id);
      if (!ws) {
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          `知识库不存在或数据损坏: ${id}`,
        );
      }
      store.workspaces.set(id, { ...ws, ...patch, id, updatedAt: Date.now() });
    },
    async setFavorite(id, favoriteAt) {
      const ws = store.workspaces.get(id);
      if (!ws) {
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          `知识库不存在或数据损坏: ${id}`,
        );
      }
      store.workspaces.set(id, { ...ws, favoriteAt, updatedAt: Date.now() });
    },
    async setLastOpened(id, at) {
      const ws = store.workspaces.get(id);
      if (!ws) return;
      store.workspaces.set(id, { ...ws, lastOpenedAt: at });
    },
  };

  const page: PageRepository = {
    async listByWorkspace(workspaceId) {
      return allPages().filter((p) => p.workspaceId === workspaceId);
    },
    async listAll() {
      return allPages();
    },
    async create(input) {
      validateCreatePageInput(input);
      if (!store.workspaces.has(input.workspaceId)) {
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          `知识库不存在或数据损坏: ${input.workspaceId}`,
        );
      }
      if (input.parentId !== null) {
        assertValidParent(input.parentId, input.workspaceId);
      }
      const siblings = allPages().filter(
        (p) => p.workspaceId === input.workspaceId,
      );
      const now = Date.now();
      const created: Page = {
        id: createId(),
        workspaceId: input.workspaceId,
        parentId: input.parentId,
        kind: input.kind,
        title: input.title,
        icon: input.icon ?? null,
        position: nextPosition(siblings, input.parentId),
        favoriteAt: null,
        lastOpenedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      store.pages.set(created.id, created);
      // 不变量：有文档必有 contents 记录。
      if (created.kind === "document") {
        store.contents.set(created.id, {
          pageId: created.id,
          workspaceId: created.workspaceId,
          contentJson: { type: "doc", content: [] },
          textSnapshot: "",
          // 新文档首版正文（R004 阶段 7）。
          version: 1,
          updatedAt: now,
        });
      }
      return created;
    },
    async rename(id, title) {
      const target = getRequiredPage(id);
      store.pages.set(id, { ...target, title, updatedAt: Date.now() });
    },
    async setFavorite(id, favoriteAt) {
      const target = getRequiredPage(id);
      store.pages.set(id, { ...target, favoriteAt, updatedAt: Date.now() });
    },
    async setLastOpened(id, at) {
      const target = getRequiredPage(id);
      store.pages.set(id, { ...target, lastOpenedAt: at });
    },
    async move(id, newParentId, index) {
      const target = getRequiredPage(id);
      if (newParentId !== null) {
        assertValidParent(newParentId, target.workspaceId);
      }
      if (wouldCreateCycle(allPages(), id, newParentId)) {
        throw new DomainError("PAGE_TREE_CYCLE", "不能移动到自身或其子页面下");
      }
      const workspacePages = allPages().filter(
        (p) => p.workspaceId === target.workspaceId,
      );
      const targetIndex =
        index ??
        childrenOf(workspacePages, newParentId).filter((p) => p.id !== id)
          .length;
      const next = movePage(workspacePages, id, newParentId, targetIndex);
      const now = Date.now();
      for (const p of next) {
        const before = workspacePages.find((w) => w.id === p.id);
        if (
          before &&
          (before.parentId !== p.parentId || before.position !== p.position)
        ) {
          store.pages.set(p.id, { ...p, updatedAt: now });
        }
      }
    },
    async remove(id) {
      getRequiredPage(id);
      const now = Date.now();
      for (const pageId of collectSubtreeIds(allPages(), id)) {
        const target = store.pages.get(pageId);
        if (!target || target.deletedAt !== null) continue;
        store.pages.set(pageId, { ...target, deletedAt: now, updatedAt: now });
        store.trash.set(pageId, {
          pageId,
          deletedAt: now,
          originalParentId: target.parentId,
        });
      }
    },
    async restore(id) {
      getRequiredPage(id);
      const ids = collectSubtreeIds(allPages(), id);
      const now = Date.now();
      for (const pageId of ids) {
        const target = store.pages.get(pageId);
        if (!target || target.deletedAt === null) continue;
        const record = store.trash.get(pageId);
        let parentId = record?.originalParentId ?? null;
        const parent = parentId ? store.pages.get(parentId) : undefined;
        // 原父级已不存在或仍在回收站（且不在本次恢复子树内）时回到根。
        if (
          parentId &&
          (!parent || (parent.deletedAt !== null && !ids.includes(parentId)))
        ) {
          parentId = null;
        }
        const siblings = allPages().filter(
          (p) => p.workspaceId === target.workspaceId && p.id !== target.id,
        );
        store.pages.set(pageId, {
          ...target,
          parentId,
          position: nextPosition(siblings, parentId),
          deletedAt: null,
          updatedAt: now,
        });
        store.trash.delete(pageId);
      }
    },
    async purge(id) {
      getRequiredPage(id);
      for (const pageId of collectSubtreeIds(allPages(), id)) {
        store.pages.delete(pageId);
        store.contents.delete(pageId);
        store.trash.delete(pageId);
        for (const [key, pt] of store.pageTags) {
          if (pt.pageId === pageId) store.pageTags.delete(key);
        }
        for (const [revId, rev] of store.revisions) {
          if (rev.pageId === pageId) store.revisions.delete(revId);
        }
        for (const [attId, att] of store.attachments) {
          if (att.pageId === pageId) store.attachments.delete(attId);
        }
      }
    },
    async purgeTrashed(workspaceId) {
      const trashed = allPages().filter(
        (p) => p.workspaceId === workspaceId && p.deletedAt !== null,
      );
      for (const p of trashed) {
        await page.purge(p.id);
      }
    },
  };

  const content: ContentRepository = {
    async get(pageId) {
      const record = store.contents.get(pageId);
      return record ? toDomainContent(record) : undefined;
    },
    async save(pageId, contentJson, textSnapshot, expectedVersion) {
      // 与 IndexedDB 实现同约束：页面不存在时显式失败（R004 阶段 5）；
      // 乐观锁（R004 阶段 7；R005 阶段 3 起为不透明令牌）：版本不匹配抛
      // DOCUMENT_CONFLICT，存量无 version 记录视为初始版本 0；
      // 非 "mem:N" 编码的令牌（expected === null）同样视为冲突。
      const target = store.pages.get(pageId);
      if (!target) {
        throw new DomainError(
          "PAGE_NOT_FOUND",
          `页面不存在或数据损坏: ${pageId}`,
        );
      }
      const currentVersion = store.contents.get(pageId)?.version ?? 0;
      const expected = tokenToVersion(expectedVersion);
      if (expected === null || currentVersion !== expected) {
        throw new DomainError(
          "DOCUMENT_CONFLICT",
          `文档已在其他地方被修改（当前版本 ${versionToToken(currentVersion)}，期望 ${expectedVersion || "（空令牌）"}）`,
        );
      }
      const updatedAt = Date.now();
      const nextVersion = currentVersion + 1;
      store.contents.set(pageId, {
        pageId,
        workspaceId: target.workspaceId,
        contentJson,
        textSnapshot,
        version: nextVersion,
        updatedAt,
      });
      return { version: versionToToken(nextVersion), updatedAt };
    },
    async listAll() {
      return [...store.contents.values()].map(toDomainContent);
    },
    async listByWorkspace(workspaceId) {
      return [...store.contents.values()]
        .filter((c) => c.workspaceId === workspaceId)
        .map(toDomainContent);
    },
  };

  // 原子文档写（R004 阶段 2，INV-04）：与 IndexedDB 实现同契约——
  // 校验失败或目标非法时不产生任何写入（内存操作天然同步，无中间态可见）。
  const documentWrite: DocumentWriteRepository = {
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
      if (!store.workspaces.has(input.workspaceId)) {
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          `知识库不存在或数据损坏: ${input.workspaceId}`,
        );
      }
      if (input.parentId !== null) {
        assertValidParent(input.parentId, input.workspaceId);
      }
      const siblings = allPages().filter(
        (p) => p.workspaceId === input.workspaceId,
      );
      const now = Date.now();
      // 与 IndexedDB 实现一致：迁移路径可保留原时间戳，非法值回退 now。
      const createdAt =
        typeof input.createdAt === "number" &&
        Number.isFinite(input.createdAt) &&
        input.createdAt > 0
          ? input.createdAt
          : now;
      const updatedAt =
        typeof input.updatedAt === "number" &&
        Number.isFinite(input.updatedAt) &&
        input.updatedAt > 0
          ? input.updatedAt
          : createdAt;
      const created: Page = {
        id: createId(),
        workspaceId: input.workspaceId,
        parentId: input.parentId,
        kind: "document",
        title: input.title,
        icon: input.icon ?? null,
        position: nextPosition(siblings, input.parentId),
        favoriteAt: null,
        lastOpenedAt: null,
        deletedAt: null,
        createdAt,
        updatedAt,
      };
      store.pages.set(created.id, created);
      store.contents.set(created.id, {
        pageId: created.id,
        workspaceId: created.workspaceId,
        contentJson: parsed.value,
        textSnapshot: input.textSnapshot,
        // 新文档首版正文（R004 阶段 7）。
        version: 1,
        updatedAt: now,
      });
      return created;
    },
    async replaceContent(input) {
      const parsed = parseDocumentContent(input.contentJson);
      if (!parsed.ok) {
        throw new DomainError(
          "CORRUPTED_DOCUMENT",
          "正文 JSON 未通过白名单校验",
        );
      }
      const target = getRequiredPage(input.pageId);
      // 与 IndexedDB 实现一致：外部覆盖路径不做冲突检查，version 照常递增。
      const currentVersion = store.contents.get(input.pageId)?.version ?? 0;
      const record: StoredMemoryContent = {
        pageId: input.pageId,
        workspaceId: target.workspaceId,
        contentJson: parsed.value,
        textSnapshot: input.textSnapshot,
        version: currentVersion + 1,
        updatedAt: Date.now(),
      };
      store.contents.set(input.pageId, record);
      // 写边界转换：内部 number → 领域令牌（R005 阶段 3）。
      return toDomainContent(record);
    },
  };

  const revision: RevisionRepository = {
    async listByPage(pageId) {
      return [...store.revisions.values()]
        .filter((r) => r.pageId === pageId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async add(pageId, contentJson, textSnapshot, reason) {
      const latest = (await revision.listByPage(pageId))[0];
      if (
        latest &&
        JSON.stringify(latest.contentJson ?? null) ===
          JSON.stringify(contentJson ?? null)
      ) {
        return null;
      }
      const rev: DocumentRevision = {
        id: createId(),
        pageId,
        contentJson,
        textSnapshot,
        createdAt: Date.now(),
        reason,
      };
      store.revisions.set(rev.id, rev);
      return rev;
    },
    async pruneInterval(pageId, keep, maxBytes) {
      const interval = (await revision.listByPage(pageId)).filter(
        (r) => r.reason === "interval",
      );
      // 与 IndexedDB 实现同规则：数量 + 总字节双重预算（R004 阶段 6）。
      const excess = selectRevisionsToPrune(
        interval.map((r) => ({
          ...r,
          bytes: revisionContentBytes(r.contentJson),
        })),
        keep,
        maxBytes ?? Number.POSITIVE_INFINITY,
      );
      for (const r of excess) {
        store.revisions.delete(r.id);
      }
    },
  };

  /** 内存附件记录 → 领域元数据（剥离字节字段）。 */
  const attachmentMetadata = (record: StoredMemoryAttachment): Attachment => ({
    id: record.id,
    pageId: record.pageId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
  });

  const assetStore: AssetStore = {
    async getMetadata(id) {
      const record = store.attachments.get(id);
      return record ? attachmentMetadata(record) : undefined;
    },
    async getBinary(id) {
      const record = store.attachments.get(id);
      if (!record) return undefined;
      return { attachment: attachmentMetadata(record), data: record.data };
    },
    async listByDocument(pageId) {
      return [...store.attachments.values()]
        .filter((a) => a.pageId === pageId)
        .map(attachmentMetadata);
    },
    async add(input) {
      const record: StoredMemoryAttachment = {
        id: createId(),
        pageId: input.pageId,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        data: requireAttachmentBytes(input),
        createdAt: Date.now(),
      };
      store.attachments.set(record.id, record);
      return attachmentMetadata(record);
    },
    async remove(id) {
      store.attachments.delete(id);
    },
    async removeOrphans(pageId, referencedIds, options) {
      const referenced = new Set(referencedIds);
      const cutoff = options?.createdBeforeOrAt;
      // 与 IndexedDB 实现同约束：只清理快照产生之前已存在的孤儿（R004 INV-03）。
      const orphans = [...store.attachments.values()].filter(
        (a) =>
          a.pageId === pageId &&
          !referenced.has(a.id) &&
          (cutoff === undefined || a.createdAt <= cutoff),
      );
      for (const a of orphans) store.attachments.delete(a.id);
      return orphans.length;
    },
  };

  const tag: TagRepository = {
    async listByWorkspace(workspaceId) {
      return [...store.tags.values()].filter(
        (t) => t.workspaceId === workspaceId,
      );
    },
    async create(workspaceId, name, color) {
      const record: Tag = { id: createId(), workspaceId, name, color };
      store.tags.set(record.id, record);
      return record;
    },
    async remove(id) {
      store.tags.delete(id);
      for (const [key, pt] of store.pageTags) {
        if (pt.tagId === id) store.pageTags.delete(key);
      }
    },
    async listPageTagIds(pageId) {
      return [...store.pageTags.values()]
        .filter((pt) => pt.pageId === pageId)
        .map((pt) => pt.tagId);
    },
    async listWorkspacePageTags(workspaceId) {
      return [...store.pageTags.values()].filter(
        (pt) => pt.workspaceId === workspaceId,
      );
    },
    async setPageTags(pageId, tagIds) {
      const target = store.pages.get(pageId);
      if (!target) {
        throw new DomainError(
          "PAGE_NOT_FOUND",
          `页面不存在或数据损坏: ${pageId}`,
        );
      }
      const uniqueTagIds = [...new Set(tagIds)];
      for (const tagId of uniqueTagIds) {
        const record = store.tags.get(tagId);
        if (!record) {
          throw new DomainError(
            "TAG_NOT_FOUND",
            `标签不存在或数据损坏: ${tagId}`,
          );
        }
        if (record.workspaceId !== target.workspaceId) {
          throw new DomainError(
            "CROSS_WORKSPACE_TAG",
            "标签与页面属于不同知识库，不能绑定",
          );
        }
      }
      for (const [key, pt] of store.pageTags) {
        if (pt.pageId === pageId) store.pageTags.delete(key);
      }
      for (const tagId of uniqueTagIds) {
        store.pageTags.set(`${pageId}${tagId}`, {
          pageId,
          tagId,
          workspaceId: target.workspaceId,
        });
      }
    },
  };

  const preferences: PreferencesRepository = {
    async get() {
      return store.preferences;
    },
    async update(patch) {
      store.preferences = { ...store.preferences, ...patch, id: "preferences" };
      return store.preferences;
    },
  };

  return {
    workspace,
    page,
    content,
    documentWrite,
    revision,
    assetStore,
    tag,
    preferences,
  };
}
