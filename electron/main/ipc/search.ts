/**
 * R008 Stage 4（§11/§15.1）：search 组 IPC handler——SQLite 全文索引的
 * 查询/重建/增量维护。
 *
 * 授权与只读语义：transient 仅预览会话同样允许（搜索是只读派生能力，
 * 索引落 userData 不写 Vault）；handler 永不 throw（统一信封）。
 * Renderer 只传 vaultId + relativePath/query（DSK-02 不变）。
 */
import {
  IPC_CHANNELS,
  type SearchIndexStatus,
  type SearchQueryRow,
  type SearchRebuildResult,
  type SearchUpsertResult,
} from "../../../shared/ipc/contracts.js";
import {
  parseSearchQueryInput,
  parseSearchRelocateInput,
  parseSearchUpsertInput,
  parseSearchVaultInput,
} from "../../../shared/ipc/schemas.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import type { DesktopSearchIndexManager } from "../search/DesktopSearchDatabase.js";
import {
  iterateVaultSearchDocuments,
  searchDocumentFromMarkdown,
} from "../search/DesktopSearchIndexer.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface SearchHandlerDeps extends VaultRootDeps {
  indexes: DesktopSearchIndexManager;
}

export function registerSearchHandlers(
  bus: IpcMainLike,
  deps: SearchHandlerDeps,
): void {
  const { indexes } = deps;

  bus.handle(
    IPC_CHANNELS.searchQuery,
    handleRequest(
      parseSearchQueryInput,
      async (input): Promise<SearchQueryRow[]> => {
        // 跨库查询：逐库检索后合并重排（行已携带稳定键与路径）。
        if (!input.vaultId) {
          const grouped = await indexes.searchAll(input);
          return grouped;
        }
        await resolveVaultRoot(input.vaultId, deps);
        return indexes.forVault(input.vaultId).search(input);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.searchRebuild,
    handleRequest(
      parseSearchVaultInput,
      async (input): Promise<SearchRebuildResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const db = indexes.forVault(input.vaultId);
        await db.rebuild(
          iterateVaultSearchDocuments({
            vaultId: input.vaultId,
            vaultRoot: root.absolutePath,
          }),
        );
        const status = db.getStatus(input.vaultId);
        return {
          indexedDocuments:
            status.state === "ready" ? status.indexedDocuments : 0,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.searchUpsert,
    handleRequest(
      parseSearchUpsertInput,
      async (input): Promise<SearchUpsertResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        try {
          const file = await readNoteFile({
            vaultRoot: root.absolutePath,
            relativePath: input.relativePath,
          });
          await indexes.forVault(input.vaultId).upsert(
            searchDocumentFromMarkdown({
              vaultId: input.vaultId,
              relativePath: input.relativePath,
              markdown: file.markdown,
              versionToken: file.versionToken,
              modifiedAt: file.modifiedAt,
            }),
          );
          return { indexed: true };
        } catch {
          // 文件已消失（与 deleted 竞态）：按未索引处理，调用方走 remove。
          return { indexed: false };
        }
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.searchRemove,
    handleRequest(parseSearchUpsertInput, async (input): Promise<void> => {
      await resolveVaultRoot(input.vaultId, deps);
      await indexes
        .forVault(input.vaultId)
        .removeByPath(input.vaultId, input.relativePath);
    }),
  );

  bus.handle(
    IPC_CHANNELS.searchRelocate,
    handleRequest(parseSearchRelocateInput, async (input): Promise<void> => {
      await resolveVaultRoot(input.vaultId, deps);
      await indexes
        .forVault(input.vaultId)
        .relocateByPath(input.vaultId, input.from, input.to);
    }),
  );

  bus.handle(
    IPC_CHANNELS.searchStatus,
    handleRequest(
      parseSearchVaultInput,
      async (input): Promise<SearchIndexStatus> => {
        await resolveVaultRoot(input.vaultId, deps);
        return indexes.forVault(input.vaultId).getStatus(input.vaultId);
      },
    ),
  );
}
