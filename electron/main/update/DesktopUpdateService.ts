/**
 * R009 Stage 6（Auto Update）：electron-updater 状态机封装。
 *
 * 链路：GitHub Releases feed（仅 stable 通道，latest*.yml 随 Release 分发）
 * → electron-updater 检查/下载 → 用户确认安装（autoDownload=false，
 * autoInstallOnAppQuit=true，install 显式 quitAndInstall）。
 *
 * 平台分流（R009 §Stage 6 决策）：
 * - Windows NSIS 未签名亦可自动更新 → canAutoInstall=true；
 * - macOS Squirrel.Mac 拒绝替换未签名应用（Stage 4 签名延期）→
 *   canAutoInstall=false，download 为 no-op，UI 降级为「前往下载」手动链路。
 *   Stage 4 签名落地后把 supportsAutoInstall 的 darwin 分支翻 true。
 *
 * 安全约束：所有 electron/OS 依赖经构造注入（单测不 mock 模块）；
 * error 事件只沉淀为 status.state="error"，事件回调永不 throw——
 * 更新失败不得影响现有安装（DIST-07）。
 */
import type { UpdateStatus } from "../../../shared/ipc/contracts.js";

/** electron-updater autoUpdater 的最小结构视图（测试注入 fake）。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: (info: { version: string }) => void): unknown;
  on(
    event: "download-progress",
    listener: (progress: { percent: number }) => void,
  ): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  setFeedURL(url: string): void;
}

export interface DesktopUpdateServiceDeps {
  /**
   * electron-updater 实例。isPackaged=false 时可为空（构造与运行都不触碰）；
   * isPackaged=true 时必须注入，否则构造抛错（装配错误，尽早暴露）。
   */
  autoUpdater?: AutoUpdaterLike;
  platform: NodeJS.Platform;
  /** 未打包（dev / 源码直起）一律 unsupported，不触网。 */
  isPackaged: boolean;
  currentVersion: string;
  /** 状态推送出口（缺省遍历全部窗口广播，见 ipc/index.ts）。 */
  emit: (status: UpdateStatus) => void;
  /** 打开 Release 页（shell.openExternal 注入，E2E 可 stub）。 */
  openExternal: (url: string) => Promise<void>;
  /** E1_UPDATE_FEED_URL：手动 QA 用本地静态服务器演练完整链路。 */
  feedUrlOverride?: string;
  releasePageUrl?: string;
}

const DEFAULT_RELEASE_PAGE_URL = "https://github.com/ArthurFree/e1/releases";

export class DesktopUpdateService {
  private readonly updater: AutoUpdaterLike | null = null;
  private readonly emit: (status: UpdateStatus) => void;
  private readonly openExternal: (url: string) => Promise<void>;
  private status: UpdateStatus;

  constructor(deps: DesktopUpdateServiceDeps) {
    this.emit = deps.emit;
    this.openExternal = deps.openExternal;
    this.status = {
      state: deps.isPackaged ? "idle" : "unsupported",
      currentVersion: deps.currentVersion,
      // macOS 未签名期间降级手动下载（Stage 4 签名后 darwin 翻 true）。
      canAutoInstall: deps.platform === "win32",
      releasePageUrl: deps.releasePageUrl ?? DEFAULT_RELEASE_PAGE_URL,
    };

    if (!deps.isPackaged) return;
    if (!deps.autoUpdater) {
      throw new Error("DesktopUpdateService: isPackaged 环境必须注入 autoUpdater");
    }
    const updater = deps.autoUpdater;
    this.updater = updater;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    if (deps.feedUrlOverride) {
      updater.setFeedURL(deps.feedUrlOverride);
    }
    updater.on("update-available", (info) => {
      this.patch({
        state: "available",
        latestVersion: info.version,
        progressPercent: undefined,
        errorMessage: undefined,
      });
    });
    updater.on("update-not-available", () => {
      this.patch({ state: "not-available", errorMessage: undefined });
    });
    updater.on("download-progress", (progress) => {
      this.patch({
        state: "downloading",
        progressPercent: Math.round(progress.percent),
      });
    });
    updater.on("update-downloaded", (info) => {
      this.patch({
        state: "downloaded",
        latestVersion: info.version,
        progressPercent: 100,
      });
    });
    updater.on("error", (error) => {
      // 更新失败不影响现有安装（DIST-07）：只沉淀状态，不向上抛。
      this.patch({
        state: "error",
        errorMessage: error.message || "未知更新错误",
        progressPercent: undefined,
      });
    });
  }

  getState(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (!this.updater) return this.getState();
    this.patch({ state: "checking", errorMessage: undefined });
    try {
      const result = await this.updater.checkForUpdates();
      // 事件正常驱动状态；兜底：事件未触发时按返回版本比较收口，
      // 避免状态卡在 checking。
      if (this.status.state === "checking") {
        const latest = result?.updateInfo?.version;
        if (latest && latest !== this.status.currentVersion) {
          this.patch({ state: "available", latestVersion: latest });
        } else {
          this.patch({ state: "not-available" });
        }
      }
    } catch (error) {
      this.patch({
        state: "error",
        errorMessage: error instanceof Error ? error.message : "检查更新失败",
      });
    }
    return this.getState();
  }

  async download(): Promise<UpdateStatus> {
    // canAutoInstall=false（macOS 未签名降级）为 no-op：UI 改走 openReleasePage。
    if (!this.updater || !this.status.canAutoInstall) {
      return this.getState();
    }
    if (this.status.state !== "available") return this.getState();
    this.patch({ state: "downloading", progressPercent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.patch({
        state: "error",
        errorMessage: error instanceof Error ? error.message : "下载更新失败",
        progressPercent: undefined,
      });
    }
    return this.getState();
  }

  /** 退出并安装（仅 downloaded 有意义；其余状态 no-op）。 */
  install(): void {
    if (!this.updater || this.status.state !== "downloaded") return;
    this.updater.quitAndInstall();
  }

  async openReleasePage(): Promise<void> {
    await this.openExternal(this.status.releasePageUrl);
  }

  private patch(partial: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...partial };
    this.emit(this.getState());
  }
}
