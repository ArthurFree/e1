/**
 * R010 Stage 3（§6/§11）：link 组 IPC handler——SQLite 派生链接索引的
 * 查询/重建/增量维护（与搜索共库单连接，DesktopVaultIndexManager 注入）。
 *
 * 授权与只读语义：transient 仅预览会话同样允许（链接索引是只读派生
 * 能力，索引落 userData 不写 Vault）；handler 永不 throw（统一信封）。
 * Renderer 只传 vaultId + relativePath/noteKey（DSK-02 同口径）。
 */
import {
  IPC_CHANNELS,
  type Backlink,
  type DocumentLink,
  type LinkRebuildResult,
  type LinkUpsertResult,
  type SearchIndexStatus,
} from "../../../shared/ipc/contracts.js";
import {
  parseLinkQueryInput,
  parseLinkRelocateInput,
  parseLinkRemoveInput,
  parseLinkUpsertInput,
  parseLinkVaultInput,
} from "../../../shared/ipc/schemas.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import type { DesktopLinkDatabase } from "../links/DesktopLinkDatabase.js";
import {
  iterateVaultLinkDocuments,
  linkDocumentFromMarkdown,
} from "../links/DesktopLinkIndexer.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** link 组消费的索引面（DesktopVaultIndexManager.linksFor 满足）。 */
export interface LinkIndexProvider {
  linksFor(vaultId: string): DesktopLinkDatabase;
}

export interface LinkHandlerDeps extends VaultRootDeps {
  indexes: LinkIndexProvider;
}

export function registerLinkHandlers(
  bus: IpcMainLike,
  deps: LinkHandlerDeps,
): void {
  const { indexes } = deps;

  bus.handle(
    IPC_CHANNELS.linkOutgoing,
    handleRequest(
      parseLinkQueryInput,
      async (input): Promise<DocumentLink[]> => {
        await resolveVaultRoot(input.vaultId, deps);
        return indexes
          .linksFor(input.vaultId)
          .getOutgoing(input.vaultId, input.noteKey);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.linkBacklinks,
    handleRequest(parseLinkQueryInput, async (input): Promise<Backlink[]> => {
      await resolveVaultRoot(input.vaultId, deps);
      return indexes
        .linksFor(input.vaultId)
        .getBacklinks(input.vaultId, input.noteKey);
    }),
  );

  bus.handle(
    IPC_CHANNELS.linkBroken,
    handleRequest(
      parseLinkVaultInput,
      async (input): Promise<DocumentLink[]> => {
        await resolveVaultRoot(input.vaultId, deps);
        return indexes.linksFor(input.vaultId).getBrokenLinks(input.vaultId);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.linkRebuild,
    handleRequest(
      parseLinkVaultInput,
      async (input): Promise<LinkRebuildResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const db = indexes.linksFor(input.vaultId);
        await db.rebuild(
          iterateVaultLinkDocuments({
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
    IPC_CHANNELS.linkUpsert,
    handleRequest(
      parseLinkUpsertInput,
      async (input): Promise<LinkUpsertResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        try {
          const file = await readNoteFile({
            vaultRoot: root.absolutePath,
            relativePath: input.relativePath,
          });
          await indexes.linksFor(input.vaultId).upsertDocument(
            linkDocumentFromMarkdown({
              vaultId: input.vaultId,
              relativePath: input.relativePath,
              markdown: file.markdown,
              versionToken: file.versionToken,
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
    IPC_CHANNELS.linkRemove,
    handleRequest(parseLinkRemoveInput, async (input): Promise<void> => {
      await resolveVaultRoot(input.vaultId, deps);
      const db = indexes.linksFor(input.vaultId);
      if (input.relativePath) {
        await db.removeByPath(input.vaultId, input.relativePath);
      } else if (input.noteKey) {
        await db.remove(input.noteKey);
      }
    }),
  );

  bus.handle(
    IPC_CHANNELS.linkRelocate,
    handleRequest(parseLinkRelocateInput, async (input): Promise<void> => {
      await resolveVaultRoot(input.vaultId, deps);
      await indexes.linksFor(input.vaultId).relocate(input);
    }),
  );

  bus.handle(
    IPC_CHANNELS.linkStatus,
    handleRequest(
      parseLinkVaultInput,
      async (input): Promise<SearchIndexStatus> => {
        await resolveVaultRoot(input.vaultId, deps);
        return indexes.linksFor(input.vaultId).getStatus(input.vaultId);
      },
    ),
  );
}
