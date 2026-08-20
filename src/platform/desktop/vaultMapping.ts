/**
 * R006 阶段 2（C2）：Vault 扫描结果 → domain 实体的纯映射。
 *
 * 映射规则（r006 §7/§8，与 shared/ipc/contracts 的 VaultScanEntry 对齐）：
 * - document 页 id 取 Frontmatter noteId；缺失时以 `"path:" + relativePath`
 *   派生稳定 id——扫描只读不回写（身份回写属阶段 3+），路径在阶段 3 前
 *   不会变（移动/重命名写路径全部禁用），因此派生 id 在本阶段内稳定；
 *   阶段 3 打开笔记解析出真实 noteId 后需做 id 迁移（见 r006 §6.2）；
 * - group 恒以 `"path:" + relativePath` 为 id（分组无 Frontmatter）；
 * - parentId 由 parentPath 经同一 `"path:"` 前缀映射，根级条目为 null；
 * - position 为同级内按扫描顺序的序号（扫描已按文件名
 *   localeCompare("zh-CN") 排序——文件名排序即树的展示顺序，拖拽排序
 *   在桌面端关闭，position 仅满足 Page 形状与同级比较语义）；
 * - createdAt/updatedAt 取扫描时刻（扫描不读取文件 mtime——VaultScanEntry
 *   契约不携带时间戳，阶段 3+ 需要时再扩展契约）。
 *
 * 本模块为纯函数，不触碰 window.e1 / IPC，便于单测。
 */
import type { Page, PageTag, Tag, Workspace } from "../../domain/types";
import type {
  OpenedVault,
  RecentVault,
  TrashEntry,
  VaultScanEntry,
  VaultState,
} from "../../../shared/ipc/contracts";
import type { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";

/** 路径派生 id 前缀：与 Frontmatter noteId（ULID）不可能冲突。 */
const PATH_ID_PREFIX = "path:";
/** 标签 id 前缀：由标签名派生（Frontmatter tags 只有名称，无稳定 id）。 */
const TAG_ID_PREFIX = "tag:";

/**
 * R007 阶段 1：标签颜色确定性派生——Tag.name 进 Markdown Frontmatter，
 * Tag.color 属 E1 本地元数据（不写盘），以名称哈希稳定派生，重启不变。
 * 调色板与 TagPicker 新建标签的轮换色一致。
 */
const TAG_COLOR_PALETTE = [
  "#e16259",
  "#dfab01",
  "#0f7b6c",
  "#337ea9",
  "#6940a5",
  "#c4554d",
];

/** 标签名 → 稳定派生色（同名同色，跨会话不变）。 */
export function deterministicTagColor(name: string): string {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return TAG_COLOR_PALETTE[hash % TAG_COLOR_PALETTE.length];
}

/** 条目的页面 id：document 优先 Frontmatter noteId，否则路径派生。 */
export function pageIdOfEntry(entry: VaultScanEntry): string {
  if (entry.kind === "document" && entry.noteId) return entry.noteId;
  return `${PATH_ID_PREFIX}${entry.relativePath}`;
}

/**
 * Session 内页面 id：若 Alias Registry 记录了 Adoption，继续使用 sessionPageId
 *（INV-C4.1-02/03）；否则退回 pageIdOfEntry。
 */
export function resolveSessionPageId(
  vaultId: string,
  entry: VaultScanEntry,
  aliases?: DesktopIdentityAliasRegistry | null,
): string {
  if (entry.kind === "document" && aliases) {
    const byPath = aliases.getByRelativePath(vaultId, entry.relativePath);
    if (byPath) return byPath.sessionPageId;
    if (entry.noteId) {
      const byStable = aliases.getByStableNoteId(entry.noteId);
      if (byStable?.vaultId === vaultId) return byStable.sessionPageId;
    }
  }
  return pageIdOfEntry(entry);
}

/** 标签名 → 标签 id（同名标签在同一库内共享一个 id）。 */
export function tagIdOfName(name: string): string {
  return `${TAG_ID_PREFIX}${name}`;
}

/**
 * 回收站条目的页面 id（R007 阶段 4）：`trash:<vaultId>/<operationId>`。
 * 命令层 restore/purge 只传页面 id，仓储据此解析回 vaultId + operationId
 * （TrashEntry.operationId 是 restore/purgeTrash IPC 的定位键）。
 * 前缀与 Frontmatter noteId / path:* 不可能冲突。
 */
export function trashPageId(vaultId: string, operationId: string): string {
  return `trash:${vaultId}/${operationId}`;
}

/** 回收站页面 id → 定位信息；非回收站 id 返回 null。 */
export function parseTrashPageId(
  id: string,
): { vaultId: string; operationId: string } | null {
  if (!id.startsWith("trash:")) return null;
  const rest = id.slice("trash:".length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { vaultId: rest.slice(0, slash), operationId: rest.slice(slash + 1) };
}

/**
 * 回收站条目（vault.listTrash）→ deletedAt 非空的 Page[]（R007 阶段 4）：
 * 合并进 listByWorkspace 结果，TrashPanel 据此展示/恢复/永久删除。
 * parentId 置 null（回收站根——原父级可能已不存在，TrashPanel 只展示根）；
 * title 取原路径 basename（document 去 .md 后缀）；kind 按原路径是否 .md
 * 推断（目录即分组）。恢复后的页面身份由重新扫描的真实条目承担。
 */
export function mapTrashEntriesToPages(
  vaultId: string,
  entries: TrashEntry[],
  fallbackNow: number,
): Page[] {
  return entries.map((entry) => {
    const deletedAt = parseIso(entry.deletedAt, fallbackNow);
    const isDocument = entry.originalRelativePath
      .toLowerCase()
      .endsWith(".md");
    const basename =
      entry.originalRelativePath.split("/").pop() ??
      entry.originalRelativePath;
    return {
      id: trashPageId(vaultId, entry.operationId),
      workspaceId: vaultId,
      parentId: null,
      kind: isDocument ? "document" : "group",
      title: isDocument ? basename.replace(/\.md$/i, "") : basename,
      icon: null,
      position: 0,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt,
      createdAt: deletedAt,
      updatedAt: deletedAt,
    };
  });
}

/** ISO 时间戳 → 毫秒；非法值回退 fallback。 */
function parseIso(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * 最近 Vault → Workspace。
 * 目录不可访问（accessible=false）的条目保留在列表中、名称加后缀提示；
 * 点击后会话加载会因 scan 失败进入可重试的错误态（重新定位属阶段 6，
 * 本批不做，见 r006 §5 US-06 / §阶段 6）。
 * R007 阶段 2：favoriteAt 来自 vault-state（设备级，默认 null）。
 */
export function mapRecentVaultToWorkspace(
  vault: RecentVault,
  favoriteAt: number | null = null,
): Workspace {
  const lastOpenedAt = parseIso(vault.lastOpenedAt, 0);
  return {
    id: vault.vaultId,
    name: vault.accessible
      ? vault.displayName
      : `${vault.displayName}（目录不可访问）`,
    icon: null,
    description: "",
    homePageId: null,
    favoriteAt,
    lastOpenedAt: lastOpenedAt || null,
    createdAt: lastOpenedAt,
    updatedAt: lastOpenedAt,
  };
}

/** vault.openSelection / vault.openRecent 响应 → Workspace（打开成功即视为最近使用）。 */
export function mapOpenedVaultToWorkspace(
  vault: OpenedVault,
  now: number,
  favoriteAt: number | null = null,
): Workspace {
  const baseName = vault.name || vault.displayName;
  return {
    id: vault.vaultId,
    // R006-C2.1（FR-03「仅预览」）：transient 会话名称加后缀标识——
    // 不写注册表、重启消失，与常规 Vault 在列表中可区分。
    name: vault.transient ? `${baseName}（预览）` : baseName,
    icon: null,
    description: "",
    homePageId: null,
    favoriteAt,
    lastOpenedAt: now,
    createdAt: parseIso(vault.createdAt, now),
    updatedAt: now,
  };
}

/**
 * R007 阶段 2：从 vault-state 取单页交互状态。stableNoteId 键优先；
 * 无条目时以 Adoption 前的 path:<relativePath> 键兜底（写入侧
 * DesktopVaultStateClient.patchPage 会顺带清空旧键完成迁移）。
 */
export function pageStateOfEntry(
  entry: VaultScanEntry,
  state: VaultState | null | undefined,
): { favoriteAt: number | null; lastOpenedAt: number | null } {
  if (!state || entry.kind !== "document") {
    return { favoriteAt: null, lastOpenedAt: null };
  }
  const pathKey = `${PATH_ID_PREFIX}${entry.relativePath}`;
  const found = entry.noteId
    ? (state.pages[entry.noteId] ?? state.pages[pathKey])
    : state.pages[pathKey];
  return {
    favoriteAt: found?.favoriteAt ?? null,
    lastOpenedAt: found?.lastOpenedAt ?? null,
  };
}

/**
 * 扫描条目 → Page[]（扁平，顺序保持扫描的 DFS 序）。
 * 调用方保证 entries 来自同一次扫描（parentPath 指向的 group 条目必然
 * 先于其子条目出现，Main 侧 DFS 序保证）。
 * R007 阶段 2：可选 state（vault-state）合并 favoriteAt/lastOpenedAt。
 */
export function mapScanEntriesToPages(
  vaultId: string,
  entries: VaultScanEntry[],
  scannedAt: number,
  aliases?: DesktopIdentityAliasRegistry | null,
  state?: VaultState | null,
): Page[] {
  // 同级序号计数器：key 为 parentPath（根级为 null）。
  const siblingCount = new Map<string | null, number>();
  return entries.map((entry) => {
    const position = siblingCount.get(entry.parentPath) ?? 0;
    siblingCount.set(entry.parentPath, position + 1);
    const pageState = pageStateOfEntry(entry, state);
    return {
      id: resolveSessionPageId(vaultId, entry, aliases),
      workspaceId: vaultId,
      parentId:
        entry.parentPath === null
          ? null
          : `${PATH_ID_PREFIX}${entry.parentPath}`,
      kind: entry.kind,
      title: entry.title,
      icon: null,
      position,
      favoriteAt: pageState.favoriteAt,
      lastOpenedAt: pageState.lastOpenedAt,
      deletedAt: null,
      createdAt: scannedAt,
      updatedAt: scannedAt,
    };
  });
}

/**
 * 扫描条目 → 标签定义与页面-标签关联。
 * 标签按名称去重（同名同 id）；关联的 pageId 与 mapScanEntriesToPages
 * 经同一 pageIdOfEntry 派生，两边必然一致。
 */
export function mapScanEntriesToTags(
  vaultId: string,
  entries: VaultScanEntry[],
  aliases?: DesktopIdentityAliasRegistry | null,
): { tags: Tag[]; pageTags: PageTag[] } {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  const pageTags: PageTag[] = [];
  for (const entry of entries) {
    if (entry.kind !== "document") continue;
    for (const name of entry.tags) {
      const tagId = tagIdOfName(name);
      if (!seen.has(tagId)) {
        seen.add(tagId);
        tags.push({
          id: tagId,
          workspaceId: vaultId,
          name,
          color: deterministicTagColor(name),
        });
      }
      pageTags.push({
        pageId: resolveSessionPageId(vaultId, entry, aliases),
        tagId,
        workspaceId: vaultId,
      });
    }
  }
  return { tags, pageTags };
}
