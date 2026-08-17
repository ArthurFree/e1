/**
 * R007 阶段 3（DSK-01/DSK-02）：Vault 文件监听与事件广播源。
 *
 * VaultWatcher 封装单个 vault 的 chokidar 监听：
 * - 配置：ignoreInitial、不跟随符号链接、awaitWriteFinish（200ms 稳定阈值），
 *   避免编辑器/外部工具半写状态触发事件；
 * - 忽略规则（createIgnored）：`.` 开头的路径段（天然覆盖 `.e1/` 与
 *   AtomicFileWriter 临时文件 `.<name>.e1-tmp-<hex>`，但 `.e1/vault.json`
 *   例外必须监听）、`node_modules`、`*.tmp`；
 * - 事件分类（classifyWatchPath）：`.md` → note-*；受管 assetsDirectory
 *   （来自 .e1/vault.json，读不到回退 "assets"）下 → asset-changed；
 *   `.e1/vault.json` → rescan-required；其余文件忽略；
 * - 自写抑制：事件进 coalescer 之前查询 SelfWriteRegistry——note 的
 *   add/change 读当前文件算 sha256 token 比对；unlink 与 asset 事件
 *   currentToken 为 null（无 token 记录直接命中）；命中即整条丢弃，
 *   抑制后事件为空则自然不产生任何推送。
 *
 * VaultWatcherService 管理多 vault：ensureWatching 幂等、closeAll 退出清理。
 * watcher 失败（目录被删、句柄耗尽等）只 console.warn 并广播一条
 * rescan-required，绝不让异常逃逸到 IPC 层。
 */
import { watch } from "chokidar";
import { readFile } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import type { VaultFsEvent } from "../../../shared/ipc/contracts.js";
import { sha256Token } from "../filesystem/AtomicFileWriter.js";
import { readVault } from "../filesystem/VaultFileSystem.js";
import { SelfWriteRegistry } from "./SelfWriteRegistry.js";
import {
  WatchEventCoalescer,
  type RawWatchEvent,
  type WatchEventCoalescerOptions,
} from "./WatchEventCoalescer.js";

/** chokidar FSWatcher 的最小结构视图（测试可注入假实现）。 */
export interface FSWatcherLike {
  on(
    event: "all",
    listener: (eventName: string, path: string) => void,
  ): this;
  on(event: "error", listener: (error: unknown) => void): this;
  close(): Promise<void>;
}

/** 传给 watch 工厂的选项（chokidar WatchOptions 的本项目子集）。 */
export interface VaultWatchOptions {
  ignoreInitial: boolean;
  followSymlinks: boolean;
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
  ignored: (path: string) => boolean;
}

/** watch 工厂类型：注入点，默认 chokidar.watch。 */
export type WatchFactory = (
  root: string,
  options: VaultWatchOptions,
) => FSWatcherLike;

const chokidarWatchFactory: WatchFactory = (root, options) =>
  watch(root, options);

const MARKDOWN_EXTENSION = /\.md$/i;
const VAULT_META_PATH = ".e1/vault.json";
const DEFAULT_ASSETS_DIRECTORY = "assets";

/**
 * 生成 chokidar 的 ignored 函数（root 为 vault 绝对路径）。
 * 规则：`.` 开头路径段忽略（`.e1/` 与 `.e1/vault.json` 例外放行）、
 * `node_modules`、`*.tmp` 忽略。
 */
export function createIgnored(root: string): (path: string) => boolean {
  return (path: string): boolean => {
    const rel = relative(root, path);
    // 根目录自身与根之外的路径（chokidar 不会传，防御）不忽略。
    if (rel === "" || rel.startsWith("..")) return false;
    const segments = rel.split(sep);
    if (segments[0] === ".e1") {
      // .e1 下只放行目录自身与 vault.json（trash/tmp 等一律忽略）。
      return !(
        segments.length === 1 ||
        (segments.length === 2 && segments[1] === "vault.json")
      );
    }
    if (segments.some((segment) => segment.startsWith("."))) return true;
    if (segments.includes("node_modules")) return true;
    return basename(path).endsWith(".tmp");
  };
}

/** 事件分类：null 表示不关心的文件。 */
export function classifyWatchPath(
  relativePath: string,
  assetsDirectory: string,
): RawWatchEvent["category"] | null {
  if (relativePath === VAULT_META_PATH) return "vault-meta";
  const assetsPrefix = assetsDirectory.replace(/\/+$/, "") + "/";
  if (relativePath.startsWith(assetsPrefix)) return "asset";
  if (MARKDOWN_EXTENSION.test(relativePath)) return "note";
  return null;
}

/** 读取 vault.json 的 assetsDirectory；读不到/损坏/未初始化回退默认。 */
async function readAssetsDirectory(root: string): Promise<string> {
  try {
    const read = await readVault(root);
    if (read.status === "initialized" && read.meta.assetsDirectory.trim()) {
      return read.meta.assetsDirectory;
    }
  } catch {
    // 未初始化/损坏目录按默认 assets/ 处理（transient 仅预览亦如此）。
  }
  return DEFAULT_ASSETS_DIRECTORY;
}

export interface VaultWatcherDeps {
  vaultId: string;
  absolutePath: string;
  watchFactory: WatchFactory;
  selfWrites: SelfWriteRegistry;
  coalescer: WatchEventCoalescer;
  /** watcher 致命错误时的降级广播（rescan-required）。 */
  onFatal: (vaultId: string) => void;
}

/** 单个 vault 的 chokidar 封装（经 VaultWatcherService 管理）。 */
export class VaultWatcher {
  private watcher: FSWatcherLike | null = null;
  private assetsDirectory = DEFAULT_ASSETS_DIRECTORY;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly deps: VaultWatcherDeps) {}

  /** 启动监听；失败抛出（由 Service 捕获降级）。 */
  start(): Promise<void> {
    this.startPromise ??= this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const { absolutePath, watchFactory } = this.deps;
    this.assetsDirectory = await readAssetsDirectory(absolutePath);
    const watcher = watchFactory(absolutePath, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: createIgnored(absolutePath),
    });
    this.watcher = watcher;
    watcher.on("all", (eventName, path) => {
      void this.handleRaw(eventName, path).catch((error) => {
        // 单事件处理失败（如读文件竞态）不炸监听：告警即可。
        console.warn(
          `[watcher] 处理事件失败 vaultId=${this.deps.vaultId} path=${path}:`,
          error,
        );
      });
    });
    watcher.on("error", (error) => {
      console.warn(`[watcher] 监听错误 vaultId=${this.deps.vaultId}:`, error);
      this.deps.onFatal(this.deps.vaultId);
    });
  }

  /** 关闭监听（等待启动完成，避免竞态泄漏）。 */
  async close(): Promise<void> {
    try {
      await this.startPromise;
    } catch {
      // 启动失败的 watcher 无需关闭。
    }
    await this.watcher?.close();
    this.watcher = null;
  }

  private async handleRaw(eventName: string, path: string): Promise<void> {
    // 只关心文件事件；addDir/unlinkDir 忽略。
    if (eventName !== "add" && eventName !== "change" && eventName !== "unlink") {
      return;
    }
    const relativePath = relative(this.deps.absolutePath, path)
      .split(sep)
      .join("/");
    if (relativePath === "" || relativePath.startsWith("..")) return;
    const category = classifyWatchPath(relativePath, this.assetsDirectory);
    if (!category) return;
    if (category !== "vault-meta") {
      // 自写抑制：note 的 add/change 算当前文件 hash；unlink/asset 传 null。
      const currentToken = await this.currentFileToken(
        path,
        category === "note" && eventName !== "unlink",
      );
      if (
        this.deps.selfWrites.shouldSuppress(
          this.deps.vaultId,
          relativePath,
          currentToken,
        )
      ) {
        return;
      }
    }
    this.deps.coalescer.push({
      vaultId: this.deps.vaultId,
      kind: eventName,
      category,
      relativePath,
    });
  }

  /** 读当前文件并算 sha256 token；不读/读不到返回 null。 */
  private async currentFileToken(
    absolutePath: string,
    shouldRead: boolean,
  ): Promise<string | null> {
    if (!shouldRead) return null;
    try {
      return sha256Token(await readFile(absolutePath));
    } catch {
      return null;
    }
  }
}

export interface VaultWatcherServiceDeps extends WatchEventCoalescerOptions {
  /** coalescer flush 后的出口（index.ts 注入 IPC 广播）。 */
  onEvents: (events: VaultFsEvent[]) => void;
  selfWrites?: SelfWriteRegistry;
  watchFactory?: WatchFactory;
}

/** 多 vault 监听管理：ensureWatching 幂等，closeAll 供 app 退出调用。 */
export class VaultWatcherService {
  /** 自写注册表（note/asset handler 经 ipc/index.ts 共享同一实例）。 */
  readonly selfWrites: SelfWriteRegistry;
  private readonly coalescer: WatchEventCoalescer;
  private readonly watchFactory: WatchFactory;
  private readonly onEvents: (events: VaultFsEvent[]) => void;
  private readonly watchers = new Map<string, VaultWatcher>();

  constructor(deps: VaultWatcherServiceDeps) {
    this.onEvents = deps.onEvents;
    this.selfWrites = deps.selfWrites ?? new SelfWriteRegistry();
    this.coalescer = new WatchEventCoalescer((_vaultId, events) => this.onEvents(events), {
      windowMs: deps.windowMs,
      maxBatchEvents: deps.maxBatchEvents,
    });
    this.watchFactory = deps.watchFactory ?? chokidarWatchFactory;
  }

  /** 幂等：同 vaultId 已在监听则忽略（重复 scan/重开同一 vault 无副作用）。 */
  ensureWatching(vaultId: string, absolutePath: string): void {
    if (this.watchers.has(vaultId)) return;
    const watcher = new VaultWatcher({
      vaultId,
      absolutePath,
      watchFactory: this.watchFactory,
      selfWrites: this.selfWrites,
      coalescer: this.coalescer,
      onFatal: (id) => {
        // watcher 致命错误：告警 + 降级广播 rescan-required（不炸 IPC）。
        this.onEvents([{ type: "rescan-required", vaultId: id }]);
      },
    });
    this.watchers.set(vaultId, watcher);
    void watcher.start().catch((error: unknown) => {
      console.warn(`[watcher] 启动监听失败 vaultId=${vaultId}:`, error);
      this.watchers.delete(vaultId);
      this.onEvents([{ type: "rescan-required", vaultId }]);
    });
  }

  isWatching(vaultId: string): boolean {
    return this.watchers.has(vaultId);
  }

  /** 关闭全部监听并丢弃未 flush 的合并窗口（app 退出前调用）。 */
  async closeAll(): Promise<void> {
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(
      all.map((watcher) =>
        watcher.close().catch((error: unknown) => {
          console.warn("[watcher] 关闭监听失败:", error);
        }),
      ),
    );
    this.coalescer.dispose();
  }
}
