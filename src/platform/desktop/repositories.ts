/**
 * R006 阶段 2（C2）：Desktop 仓储适配——domain port 的 IPC-backed 实现。
 *
 * 读路径真实（vault:listRecent / vault:open / vault:scan），写路径诚实失败：
 * 全部写操作抛 DomainError("NOT_IMPLEMENTED")（中文文案注明对应阶段），
 * 不静默成功、不写任何文件（US-01：首次打开不修改原文件）。对应阶段：
 * note.read/create/save 属阶段 3/4，附件属阶段 5，重新定位属阶段 6
 * （见 docs/requirements/r006.md）。
 *
 * 每个仓储经构造函数接收 E1DesktopAPI（由 createDesktopRuntime 注入），
 * 不直接访问 window.e1（架构门禁允许，但注入更便于单测）。
 */
import { DomainError } from "../../domain/errors";
import type {
  ContentRepository,
  PageRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import type {
  DocumentContent,
  Page,
  PageTag,
  Tag,
  Workspace,
} from "../../domain/types";
import type {
  E1DesktopAPI,
  VaultScanEntry,
  VaultScanResult,
} from "./desktopApi";
import {
  mapOpenedVaultToWorkspace,
  mapRecentVaultToWorkspace,
  mapScanEntriesToPages,
  mapScanEntriesToTags,
  pageIdOfEntry,
  tagIdOfName,
} from "./vaultMapping";

/** 一次扫描的快照：条目 + 扫描时刻（页面 createdAt/updatedAt 取它）。 */
export interface VaultScanSnapshot {
  result: VaultScanResult;
  scannedAt: number;
}

/**
 * 工作区级扫描缓存：同一会话内对同一 vaultId 只扫描一次。
 * 本批写路径全部禁用（树不会在本进程内被本应用修改），缓存不会陈旧；
 * 阶段 3+ 接入写路径后须随写操作失效/增量更新本缓存。
 */
export class DesktopVaultScanCache {
  private readonly snapshots = new Map<string, Promise<VaultScanSnapshot>>();

  constructor(private readonly api: E1DesktopAPI) {}

  /** 扫描（或取缓存）指定 Vault；并发调用共享同一 Promise。 */
  scan(vaultId: string): Promise<VaultScanSnapshot> {
    let pending = this.snapshots.get(vaultId);
    if (!pending) {
      pending = this.api.vault
        .scan(vaultId)
        .then((result) => ({ result, scannedAt: Date.now() }));
      this.snapshots.set(vaultId, pending);
      // 扫描失败（如目录中途被移走）不缓存拒绝态，下次调用重试。
      pending.catch(() => this.snapshots.delete(vaultId));
    }
    return pending;
  }

  /** 在已缓存的扫描快照中按页面 id 找条目（listPageTagIds 用）。 */
  async findEntryByPageId(pageId: string): Promise<VaultScanEntry | null> {
    for (const pending of this.snapshots.values()) {
      const snapshot = await pending.catch(() => null);
      if (!snapshot) continue;
      const entry = snapshot.result.entries.find(
        (e) => pageIdOfEntry(e) === pageId,
      );
      if (entry) return entry;
    }
    return null;
  }
}

/** 写路径统一失败：中文文案注明对应阶段，诚实失败优于静默。 */
function notImplemented(feature: string, stage: string): DomainError {
  return new DomainError(
    "NOT_IMPLEMENTED",
    `桌面端暂不支持${feature}（将在 R006 ${stage}支持）。`,
  );
}

/**
 * 知识库仓储：list 映射最近 Vault 列表；create 复用原生目录选择
 * （US-02 新建与 US-01 打开同一条「选目录 → 初始化/打开」流程）。
 */
export class DesktopWorkspaceRepository implements WorkspaceRepository {
  /** vaultId → absolutePath（list/create 时记录，setLastOpened 触碰用）。 */
  private readonly paths = new Map<string, string>();

  constructor(private readonly api: E1DesktopAPI) {}

  async list(): Promise<Workspace[]> {
    const recent = await this.api.vault.listRecent();
    for (const vault of recent) {
      if (vault.accessible) this.paths.set(vault.vaultId, vault.absolutePath);
    }
    return recent.map(mapRecentVaultToWorkspace);
  }

  /**
   * 打开本地知识库：弹出原生目录选择，取消抛 DomainError("CANCELLED")；
   * 选中后 vault.open（未初始化目录在此初始化，US-02）。
   * name 入参被忽略——本地 Vault 的名称取自 vault.json / 目录 basename，
   * Web 的「输入名称新建」语义在桌面由目录名承担（见 r006 §5 US-02）。
   */
  async create(name: string): Promise<Workspace> {
    void name;
    const selected = await this.api.vault.selectDirectory();
    if (!selected) {
      throw new DomainError("CANCELLED", "已取消选择本地目录。");
    }
    const opened = await this.api.vault.open({
      absolutePath: selected.absolutePath,
    });
    this.paths.set(opened.vaultId, opened.absolutePath);
    return mapOpenedVaultToWorkspace(opened, Date.now());
  }

  async rename(): Promise<void> {
    throw notImplemented("重命名本地知识库", "后续阶段");
  }

  async update(): Promise<void> {
    throw notImplemented("修改本地知识库信息", "后续阶段");
  }

  async setFavorite(): Promise<void> {
    throw notImplemented("收藏本地知识库", "后续阶段");
  }

  /**
   * 记录最近打开：经 vault.open 的 touch 语义刷新注册表排序（US-06）。
   * 目录不可访问等失败只告警不抛出——本方法是 fire-and-forget 的
   * 非关键路径，失败不影响已进入的会话。
   */
  async setLastOpened(id: string): Promise<void> {
    const absolutePath = this.paths.get(id);
    if (!absolutePath) return;
    try {
      await this.api.vault.open({ absolutePath });
    } catch (err) {
      console.warn("刷新最近 Vault 记录失败", err);
    }
  }
}

/** 页面仓储：listByWorkspace/listAll 真实（扫描映射），其余写操作抛错。 */
export class DesktopPageRepository implements PageRepository {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async listByWorkspace(vaultId: string): Promise<Page[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToPages(
      vaultId,
      snapshot.result.entries,
      snapshot.scannedAt,
    );
  }

  /**
   * 跨知识库全部页面（活动/收藏等全局视图用）：逐最近 Vault 扫描（经缓存），
   * 不可访问/扫描失败的库跳过并告警，不让单库故障拖垮全局视图。
   */
  async listAll(): Promise<Page[]> {
    const recent = await this.api.vault.listRecent();
    const pages: Page[] = [];
    for (const vault of recent) {
      if (!vault.accessible) continue;
      try {
        pages.push(...(await this.listByWorkspace(vault.vaultId)));
      } catch (err) {
        console.warn(`扫描 Vault「${vault.displayName}」失败，已跳过`, err);
      }
    }
    return pages;
  }

  async create(): Promise<Page> {
    throw notImplemented("新建页面", "阶段 3（note.create）");
  }

  async rename(): Promise<void> {
    throw notImplemented("重命名页面", "后续阶段（标题与文件名解耦，r006 §8）");
  }

  async setFavorite(): Promise<void> {
    throw notImplemented("收藏页面", "后续阶段");
  }

  async setLastOpened(): Promise<void> {
    throw notImplemented("记录页面浏览时间", "后续阶段");
  }

  async move(): Promise<void> {
    throw notImplemented(
      "拖拽移动页面",
      "后续阶段（桌面端拖拽排序暂时关闭，r006 §8）",
    );
  }

  async remove(): Promise<void> {
    throw notImplemented("删除页面", "后续阶段（r006：删除禁用）");
  }

  async restore(): Promise<void> {
    throw notImplemented("恢复页面", "后续阶段");
  }

  async purge(): Promise<void> {
    throw notImplemented("彻底删除页面", "后续阶段");
  }

  async purgeTrashed(): Promise<void> {
    throw notImplemented("清空回收站", "后续阶段");
  }
}

/**
 * 正文仓储：本批不读取任何 Markdown 正文（note.read 属阶段 3）。
 * get/save 抛错——get 的失败由 MainArea 加载兜底展示给用户（信息诚实，
 * 优于返回 undefined 让编辑器把有内容的笔记显示为空白文档）；
 * listAll/listByWorkspace 返回空（搜索索引因此只含标题元数据、无正文
 * 快照，r006 阶段 2 验收只要求树展示）。
 */
export class DesktopContentRepository implements ContentRepository {
  async get(): Promise<DocumentContent | undefined> {
    throw notImplemented("阅读文档内容", "阶段 3（note.read）");
  }

  async save(): Promise<{ version: string; updatedAt: number }> {
    throw notImplemented("保存文档", "阶段 4（note.save）");
  }

  async listAll(): Promise<DocumentContent[]> {
    return [];
  }

  async listByWorkspace(): Promise<DocumentContent[]> {
    return [];
  }
}

/** 标签仓储：从扫描条目的 Frontmatter tags 聚合；写操作抛错。 */
export class DesktopTagRepository implements TagRepository {
  constructor(private readonly scans: DesktopVaultScanCache) {}

  async listByWorkspace(vaultId: string): Promise<Tag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(vaultId, snapshot.result.entries).tags;
  }

  async listWorkspacePageTags(vaultId: string): Promise<PageTag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(vaultId, snapshot.result.entries).pageTags;
  }

  /** 单页标签 id：在已缓存的扫描快照中按页面 id 反查（TagPicker 用）。 */
  async listPageTagIds(pageId: string): Promise<string[]> {
    const entry = await this.scans.findEntryByPageId(pageId);
    return entry ? entry.tags.map(tagIdOfName) : [];
  }

  async create(): Promise<Tag> {
    throw notImplemented("新建标签", "后续阶段");
  }

  async remove(): Promise<void> {
    throw notImplemented("删除标签", "后续阶段");
  }

  async setPageTags(): Promise<void> {
    throw notImplemented(
      "设置页面标签",
      "后续阶段（Frontmatter 回写属阶段 3+）",
    );
  }
}
