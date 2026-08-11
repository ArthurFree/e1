/**
 * R006-C2.1：vault 组 IPC handler——授权边界收口（FR-01/02/03，SEC-01）。
 *
 * - selectDirectory：原生目录选择；选中后读 .e1/vault.json——已初始化返回
 *   真实 vaultId，未初始化返回 null（损坏/权限错误不阻断目录选择，按
 *   未初始化返回，错误留给 openSelection/openRecent 显式抛出）；同时签发
 *   一次性 selectionToken，**不再向 Renderer 返回 absolutePath**。
 * - openSelection：消费 selectionToken（先验后查，SELECTION_INVALID /
 *   SELECTION_EXPIRED）→ 目录校验 → readVault → 三分流：已初始化直接打开
 *   并登记最近列表；未初始化 + initialize=false 登记 transient 仅预览会话
 *   （FR-03「仅预览」，不写注册表）；未初始化 + initialize=true 才
 *   initializeVault（US-02，幂等）并登记最近列表。
 * - openRecent：vaultId 经注册表解析 absolutePath（Renderer 全程不见路径）
 *   → 目录检查（不可达 VAULT_NOT_FOUND）→ readVault（vault.json 消失不
 *   自动重建，SEC-07）→ touch 最近列表。
 * - listRecent：最近列表（目录不可达仅标 accessible: false，不删记录，
 *   重新定位属阶段 6）。
 * - scan：vaultId 经 resolveVaultRoot 双通道解析（注册表 + transient）。
 *
 * 旧 vault:open（absolutePath 入参）已删除——Renderer 不能凭任意绝对路径
 * 要求 Main 打开/初始化目录（SEC-01）。
 *
 * 依赖（对话框、注册表、令牌与 transient 存储）经参数注入，测试可整体
 * mock / 用 tmp 目录替身。
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
import {
  parseNoInput,
  parseOpenRecentRequest,
  parseOpenSelectionRequest,
  parseVaultScanRequest,
} from "../../../shared/ipc/schemas.js";
import {
  assertVaultRootDirectory,
  initializeVault,
  readVault,
  scanVault,
  type VaultMeta,
} from "../filesystem/VaultFileSystem.js";
import { IpcFailure } from "../../../shared/errors.js";
import { SelectionTokenStore } from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
import type { VaultRegistry } from "../vaultRegistry.js";
import { resolveVaultRoot } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** dialog.showOpenDialog 的最小结构视图（测试可注入 mock）。 */
export interface OpenDialogLike {
  showOpenDialog(options: {
    properties: ("openDirectory" | "createDirectory")[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface VaultHandlerDeps {
  openDialog?: OpenDialogLike;
  /** 最近 Vault 注册表（缺省时 openRecent/scan/listRecent 视为空表）。 */
  registry?: VaultRegistry;
  /** 目录选择授权令牌存储（缺省新建——测试注入可控制时钟）。 */
  selectionTokens?: SelectionTokenStore;
  /** transient 仅预览会话存储（缺省新建）。 */
  transients?: TransientVaultStore;
}

export function registerVaultHandlers(
  bus: IpcMainLike,
  deps: VaultHandlerDeps = {},
): void {
  const {
    openDialog = dialog,
    registry,
    selectionTokens = new SelectionTokenStore(),
    transients = new TransientVaultStore(),
  } = deps;

  bus.handle(
    IPC_CHANNELS.vaultSelectDirectory,
    handleRequest(parseNoInput, async (): Promise<SelectedVault | null> => {
      const result = await openDialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const absolutePath = result.filePaths[0];
      // 已是 Vault → 读真实 vaultId；未初始化/损坏/权限拒绝 → null（错误
      // 留给 openSelection 显式抛出，目录选择不被 .e1/vault.json 状态阻断）。
      let vaultId: string | null = null;
      try {
        const read = await readVault(absolutePath);
        if (read.status === "initialized") vaultId = read.meta.vaultId;
      } catch {
        vaultId = null;
      }
      return {
        selectionToken: selectionTokens.issue(absolutePath),
        vaultId,
        displayName: basename(absolutePath),
        initialized: vaultId !== null,
      };
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultOpenSelection,
    handleRequest(
      parseOpenSelectionRequest,
      async (input): Promise<OpenedVault> => {
        // 先验令牌后查路径（消费即删）：令牌是唯一授权凭证（SEC-01）。
        const absolutePath = selectionTokens.consume(input.selectionToken);
        await assertVaultRootDirectory(absolutePath);
        const read = await readVault(absolutePath);
        const displayName = basename(absolutePath);
        if (read.status === "initialized") {
          await registry?.touch({
            vaultId: read.meta.vaultId,
            absolutePath,
            displayName,
          });
          return openedFromMeta(read.meta, displayName, absolutePath, false);
        }
        if (!input.initialize) {
          // FR-03「仅预览」：登记 transient 会话，不创建任何文件、不进注册表。
          const transientId = transients.add(absolutePath, displayName);
          return {
            vaultId: transientId,
            absolutePath,
            name: displayName,
            displayName,
            createdAt: new Date().toISOString(),
            initialized: false,
            transient: true,
          };
        }
        // FR-03「初始化并打开」：仅此路径允许创建 .e1/vault.json 与 assets/。
        const meta = await initializeVault(absolutePath);
        await registry?.touch({
          vaultId: meta.vaultId,
          absolutePath,
          displayName,
        });
        return openedFromMeta(meta, displayName, absolutePath, true);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.vaultOpenRecent,
    handleRequest(
      parseOpenRecentRequest,
      async (input): Promise<OpenedVault> => {
        const record = await registry?.findByVaultId(input.vaultId);
        if (!record) {
          throw new IpcFailure(
            "VAULT_NOT_FOUND",
            `vaultId 未登记（请先经目录选择打开）：${input.vaultId}`,
          );
        }
        await assertVaultRootDirectory(record.absolutePath);
        const read = await readVault(record.absolutePath);
        if (read.status !== "initialized") {
          // 登记过的目录丢了 vault.json：不自动重建（SEC-07），显式失败。
          throw new IpcFailure(
            "VAULT_NOT_FOUND",
            "该目录缺少 .e1/vault.json，已不是 E1 知识库（文件保持原样，未做任何修改）。",
          );
        }
        await registry?.touch(record);
        return openedFromMeta(
          read.meta,
          record.displayName,
          record.absolutePath,
          false,
        );
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
        const root = await resolveVaultRoot(vaultId, { registry, transients });
        return scanVault(root.absolutePath);
      },
    ),
  );
}

/** VaultMeta → OpenedVault 的公共组装（initialized 标记本次是否新建）。 */
function openedFromMeta(
  meta: VaultMeta,
  displayName: string,
  absolutePath: string,
  initialized: boolean,
): OpenedVault {
  return {
    vaultId: meta.vaultId,
    absolutePath,
    name: meta.name,
    displayName,
    createdAt: meta.createdAt,
    initialized,
  };
}
