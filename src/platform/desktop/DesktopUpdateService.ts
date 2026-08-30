/**
 * R009 Stage 6（Auto Update）：UpdateService port 的 Desktop 实现——
 * 透传 preload 桥（window.e1.update / events.subscribeUpdateStatus）。
 *
 * 状态机与平台分流全部在 Main 侧（DesktopUpdateService，
 * electron/main/update/），本类只做桥接：方法直透 IPC，
 * subscribe 包装事件订阅（返回取消订阅函数）。
 */
import type {
  UpdateService,
  UpdateStatus,
} from "../../application/services/UpdateService";
import type { E1DesktopAPI } from "../../../shared/ipc/contracts";

export class DesktopUpdateService implements UpdateService {
  constructor(private readonly api: E1DesktopAPI) {}

  getState(): Promise<UpdateStatus> {
    return this.api.update.getState();
  }

  check(): Promise<UpdateStatus> {
    return this.api.update.check();
  }

  download(): Promise<UpdateStatus> {
    return this.api.update.download();
  }

  install(): Promise<void> {
    return this.api.update.install();
  }

  openReleasePage(): Promise<void> {
    return this.api.update.openReleasePage();
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    return this.api.events.subscribeUpdateStatus(listener);
  }
}
