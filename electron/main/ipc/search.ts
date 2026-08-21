/**
 * R008 Stage 4（§11/§15.1）：search 组 IPC handler。
 *
 * 全文搜索派生索引——查询与索引都在 Main（DesktopSearchService →
 * node:sqlite，userData/search-index/）。Renderer 只传 vaultId/query/
 * SearchDocument；handler 永不 throw，错误经 handleRequest 归一为
 * IpcResult 信封。服务层自行吞并索引内部错误（R8-06：经 getStatus 的
 * degraded 暴露），故本组 handler 正常路径只可能抛 schema 校验错误
 * （INVALID_INPUT/PATH_ESCAPE）；索引库绝对路径不出 Main。
 *
 * rebuild/首建只读 Vault（transient 仅预览会话同样允许建索引——索引存
 * userData，不写 Vault）；授权边界（vaultId → Vault 根解析）在注入的
 * SearchDocumentSource（VaultSearchDocumentSource）内部完成。
 */
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import {
  parseSearchQueryInput,
  parseSearchRemoveInput,
  parseSearchUpsertInput,
  parseSearchVaultInput,
} from "../../../shared/ipc/schemas.js";
import type { DesktopSearchService } from "../search/DesktopSearchService.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface SearchHandlerDeps {
  service: DesktopSearchService;
}

export function registerSearchHandlers(
  bus: IpcMainLike,
  deps: SearchHandlerDeps,
): void {
  const { service } = deps;

  bus.handle(
    IPC_CHANNELS.searchPrepare,
    handleRequest(parseSearchVaultInput, async (input): Promise<null> => {
      await service.prepareWorkspace(input.vaultId);
      return null;
    }),
  );

  bus.handle(
    IPC_CHANNELS.searchQuery,
    handleRequest(parseSearchQueryInput, (input) => service.search(input)),
  );

  bus.handle(
    IPC_CHANNELS.searchUpsert,
    handleRequest(parseSearchUpsertInput, async (input): Promise<null> => {
      await service.upsert(input.doc);
      return null;
    }),
  );

  bus.handle(
    IPC_CHANNELS.searchRemove,
    handleRequest(parseSearchRemoveInput, async (input): Promise<null> => {
      await service.remove(input);
      return null;
    }),
  );

  bus.handle(
    IPC_CHANNELS.searchRebuild,
    handleRequest(parseSearchVaultInput, (input) =>
      service.rebuild(input.vaultId),
    ),
  );

  bus.handle(
    IPC_CHANNELS.searchGetStatus,
    handleRequest(parseSearchVaultInput, (input) =>
      service.getStatus(input.vaultId),
    ),
  );
}
