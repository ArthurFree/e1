/**
 * R006 阶段 2：vault 组 IPC handler——全部真实实现。
 *
 * - selectDirectory：原生目录选择；选中后读 .e1/vault.json——已初始化返回
 *   真实 vaultId，未初始化返回 null（由 Renderer 经用户确认后调 vault.open
 *   决定初始化——US-01 首次打开不修改原文件；vault.json 损坏时不阻断目录
 *   选择，按未初始化返回，损坏错误在 open 阶段显式抛出）。
 * - open：绝对路径与目录存在性校验 → readVault / initializeVault（US-02，
 *   幂等）→ 登记最近列表（US-06）→ 返回 Vault 元信息。
 * - listRecent：最近列表（目录不可达仅标 accessible: false，不删记录，
 *   重新定位属阶段 6）。
 * - scan：vaultId 经注册表解析根目录（未登记/目录不可达 → VAULT_NOT_FOUND）
 *   → scanVault 递归扫描。
 *
 * 依赖（对话框、注册表）经参数注入，测试可整体 mock / 用 tmp 目录替身。
 */
import { dialog } from "electron";
import { basename } from "node:path";
import {
  IPC_CHANNELS,
  type OpenedVault,
  type RecentVault,
  type SelectedVault,
  type VaultScanResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parseNoInput,
  parseOpenVaultRequest,
  parseVaultScanRequest,
} from "../../../shared/ipc/schemas.js";
import {
  assertVaultRootDirectory,
  initializeVault,
  readVault,
  scanVault,
} from "../filesystem/VaultFileSystem.js";
import type { VaultRegistry } from "../vaultRegistry.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** dialog.showOpenDialog 的最小结构视图（测试可注入 mock）。 */
export interface OpenDialogLike {
  showOpenDialog(options: {
    properties: ("openDirectory" | "createDirectory")[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface VaultHandlerDeps {
  openDialog?: OpenDialogLike;
  /** 最近 Vault 注册表（缺省时 vault.open/scan/listRecent 视为空表）。 */
  registry?: VaultRegistry;
}

export function registerVaultHandlers(
  bus: IpcMainLike,
  deps: VaultHandlerDeps = {},
): void {
  const { openDialog = dialog, registry } = deps;

  bus.handle(
    IPC_CHANNELS.vaultSelectDirectory,
    handleRequest(parseNoInput, async (): Promise<SelectedVault | null> => {
      const result = await openDialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const absolutePath = result.filePaths[0];
      // 已是 Vault → 读真实 vaultId；未初始化/损坏 → null（损坏错误留给
      // vault.open 显式抛出，目录选择不被 .e1/vault.json 状态阻断）。
      let vaultId: string | null = null;
      try {
        const read = await readVault(absolutePath);
        if (read.status === "initialized") vaultId = read.meta.vaultId;
      } catch {
        vaultId = null;
      }
      return { vaultId, absolutePath, displayName: basename(absolutePath) };
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultOpen,
    handleRequest(
      parseOpenVaultRequest,
      async (input): Promise<OpenedVault> => {
        await assertVaultRootDirectory(input.absolutePath);
        const read = await readVault(input.absolutePath);
        const meta =
          read.status === "initialized"
            ? read.meta
            : await initializeVault(input.absolutePath, input.name);
        const displayName = basename(input.absolutePath);
        await registry?.touch({
          vaultId: meta.vaultId,
          absolutePath: input.absolutePath,
          displayName,
        });
        return {
          vaultId: meta.vaultId,
          absolutePath: input.absolutePath,
          name: meta.name,
          displayName,
          createdAt: meta.createdAt,
          initialized: read.status === "uninitialized",
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.vaultListRecent,
    handleRequest(
      parseNoInput,
      async (): Promise<RecentVault[]> => registry?.list() ?? [],
    ),
  );

  bus.handle(
    IPC_CHANNELS.vaultScan,
    handleRequest(
      parseVaultScanRequest,
      async (vaultId): Promise<VaultScanResult> => {
        const record = await registry?.findByVaultId(vaultId);
        if (!record) {
          throw new IpcFailure(
            "VAULT_NOT_FOUND",
            `vaultId 未登记（请先经 vault.open 打开）：${vaultId}`,
          );
        }
        try {
          await assertVaultRootDirectory(record.absolutePath);
        } catch {
          throw new IpcFailure(
            "VAULT_NOT_FOUND",
            `Vault 目录不可访问：${record.absolutePath}`,
          );
        }
        return scanVault(record.absolutePath);
      },
    ),
  );
}
