/**
 * R006 阶段 1：vault 组 IPC handler。
 * selectDirectory 为真实实现（原生目录选择对话框）；scan 属阶段 2
 * （读取/创建 .e1/vault.json + 递归扫描 .md），本阶段返回 NOT_IMPLEMENTED。
 */
import { dialog } from "electron";
import { basename } from "node:path";
import {
  IPC_CHANNELS,
  type SelectedVault,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parseNoInput,
  parseVaultScanRequest,
} from "../../../shared/ipc/schemas.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** dialog.showOpenDialog 的最小结构视图（测试可注入 mock）。 */
export interface OpenDialogLike {
  showOpenDialog(options: {
    properties: ("openDirectory" | "createDirectory")[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export function registerVaultHandlers(
  bus: IpcMainLike,
  openDialog: OpenDialogLike = dialog,
): void {
  bus.handle(
    IPC_CHANNELS.vaultSelectDirectory,
    handleRequest(parseNoInput, async (): Promise<SelectedVault | null> => {
      const result = await openDialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const absolutePath = result.filePaths[0];
      // vaultId 待阶段 2 扫描（读取/创建 .e1/vault.json）后分配。
      return {
        vaultId: null,
        absolutePath,
        displayName: basename(absolutePath),
      };
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultScan,
    handleRequest(parseVaultScanRequest, () => {
      throw new IpcFailure(
        "NOT_IMPLEMENTED",
        "vault.scan 将在 R006 阶段 2 实现",
      );
    }),
  );
}
