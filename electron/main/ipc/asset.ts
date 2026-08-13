/**
 * R006-C5：asset.pick / import / read / resolveUrl 真实实现。
 *
 * pick 签发一次性文件令牌（绝对路径只留 Main）；import 消费 token 或
 * 接收 bytes，exclusive create 进 vault.json 的 assetsDirectory；
 * read 返回字节（Portable / 下载）；resolveUrl 只返回 e1-asset://。
 */
import { dialog, type OpenDialogOptions } from "electron";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import {
  IPC_CHANNELS,
  type AssetPickRequest,
  type AssetReadResult,
  type ImportedAsset,
  type ImportAssetInput,
  type PickedFile,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  decodeDesktopAssetId,
  e1AssetUrl,
} from "../../../shared/assets/desktopAssetId.js";
import {
  parseAssetPickInput,
  parseImportAssetInput,
  parseReadAssetInput,
  parseResolveAssetUrlInput,
} from "../../../shared/ipc/schemas.js";
import {
  CapabilityTokenStore,
  FILE_TOKEN_MESSAGES,
  type PendingFileSelection,
} from "../CapabilityTokenStore.js";
import { importAssetFile, readAssetFile } from "../filesystem/AssetFileSystem.js";
import { inferMimeFromFileName } from "../filesystem/assetFileName.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface FileDialogLike {
  showOpenDialog(
    options: OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface AssetHandlerDeps extends VaultRootDeps {
  openDialog?: FileDialogLike;
  fileTokens?: CapabilityTokenStore<PendingFileSelection>;
}

function filtersFromAccept(accept?: string[]): OpenDialogOptions["filters"] {
  if (!accept || accept.length === 0) return undefined;
  const extensions = new Set<string>();
  for (const item of accept) {
    const mime = item.trim().toLowerCase();
    if (mime === "image/png") extensions.add("png");
    else if (mime === "image/jpeg") {
      extensions.add("jpg");
      extensions.add("jpeg");
    } else if (mime === "image/gif") extensions.add("gif");
    else if (mime === "image/webp") extensions.add("webp");
    else if (mime === "image/svg+xml") extensions.add("svg");
    else if (mime === "application/pdf") extensions.add("pdf");
    else if (mime.startsWith(".")) extensions.add(mime.slice(1));
  }
  if (extensions.size === 0) return undefined;
  return [{ name: "资源", extensions: [...extensions] }];
}

export function registerAssetHandlers(
  bus: IpcMainLike,
  deps: AssetHandlerDeps = {},
): void {
  const openDialog = deps.openDialog ?? dialog;
  const fileTokens =
    deps.fileTokens ?? new CapabilityTokenStore<PendingFileSelection>();

  bus.handle(
    IPC_CHANNELS.assetPick,
    handleRequest(
      parseAssetPickInput,
      async (input: AssetPickRequest): Promise<PickedFile | null> => {
        const result = await openDialog.showOpenDialog({
          properties: ["openFile"],
          filters: filtersFromAccept(input.accept),
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        const absolutePath = result.filePaths[0]!;
        let st;
        try {
          st = await stat(absolutePath);
        } catch {
          throw new IpcFailure(
            "ASSET_SOURCE_NOT_FOUND",
            "所选文件已经不存在，请重新选择。",
          );
        }
        if (!st.isFile()) {
          throw new IpcFailure("INVALID_INPUT", "只能选择普通文件。");
        }
        const name = basename(absolutePath);
        const mimeType = inferMimeFromFileName(name);
        const pickToken = fileTokens.issue({
          absolutePath,
          name,
          sizeBytes: st.size,
          mimeType,
          createdAt: Date.now(),
        });
        return {
          pickToken,
          name,
          sizeBytes: st.size,
          mimeType,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.assetImport,
    handleRequest(
      parseImportAssetInput,
      async (input: ImportAssetInput): Promise<ImportedAsset> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        if (root.transient) {
          throw new IpcFailure(
            "VAULT_READ_ONLY",
            "仅预览知识库不能导入资源。",
          );
        }
        const source =
          input.source.kind === "pick-token"
            ? {
                kind: "path" as const,
                absolutePath: fileTokens.consume(
                  input.source.token,
                  FILE_TOKEN_MESSAGES,
                ).absolutePath,
              }
            : { kind: "bytes" as const, data: input.source.data };
        return importAssetFile({
          vaultRoot: root.absolutePath,
          vaultId: input.vaultId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          source,
        });
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.assetRead,
    handleRequest(
      parseReadAssetInput,
      async (input): Promise<AssetReadResult> => {
        const decoded = decodeDesktopAssetId(input.assetId);
        if (!decoded) {
          throw new IpcFailure("INVALID_INPUT", "资源身份无效。");
        }
        const root = await resolveVaultRoot(decoded.vaultId, deps);
        const file = await readAssetFile({
          vaultRoot: root.absolutePath,
          relativePath: decoded.relativePath,
        });
        return {
          assetId: input.assetId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          data: file.data,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.assetResolveUrl,
    handleRequest(parseResolveAssetUrlInput, (assetId): string => {
      const decoded = decodeDesktopAssetId(assetId);
      if (!decoded) {
        throw new IpcFailure("INVALID_INPUT", "资源身份无效。");
      }
      return e1AssetUrl(assetId);
    }),
  );
}
