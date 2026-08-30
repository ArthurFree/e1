/**
 * 应用更新 port（R009 Stage 6 Auto Update）：「检查更新 / 下载 / 确认安装 /
 * 手动下载入口」的应用层入口。
 *
 * 只有具备应用分发与自更新能力的运行时才装配（Desktop，electron-updater +
 * GitHub Releases feed）；Web/内存容器不装配。UI 一律以
 * `services.update` 存在性门控（DUAL-01：不判断平台名称）——平台分流
 *（macOS 未签名降级手动下载）由 Main 侧完成，Renderer 只消费
 * UpdateStatus.canAutoInstall。
 *
 * 线格式与 shared/ipc/contracts 的 UpdateStatus 同构（wire 契约），
 * 本文件是 application/components 消费的平台无关视图（同
 * SecretStorageStatus.ts 口径：应用层不依赖 Electron 类型）。
 */
export type { UpdateState, UpdateStatus } from "../../../shared/ipc/contracts";

import type { UpdateStatus } from "../../../shared/ipc/contracts";

export interface UpdateService {
  /** 当前更新状态快照（不触发网络请求）。 */
  getState(): Promise<UpdateStatus>;
  /** 检查更新（触网）；结果即最新状态。 */
  check(): Promise<UpdateStatus>;
  /** 下载已发现的更新；canAutoInstall=false 时为 no-op。 */
  download(): Promise<UpdateStatus>;
  /** 退出并安装已下载的更新（仅 state=downloaded 有意义）。 */
  install(): Promise<void>;
  /** 打开 Release 页（手动下载入口）。 */
  openReleasePage(): Promise<void>;
  /** 订阅 Main 推送的更新状态；返回取消订阅函数。 */
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}
