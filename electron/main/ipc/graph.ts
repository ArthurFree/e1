/**
 * R015.1：graph 组 IPC——Main SQLite 一次取出 docs/links 后投影。
 */
import {
  IPC_CHANNELS,
  type GraphNode,
  type GraphProjection,
} from "../../../shared/ipc/contracts.js";
import {
  parseGraphNeighborhoodInput,
  parseGraphOrphansInput,
  parseGraphWorkspaceInput,
} from "../../../shared/ipc/schemas.js";
import {
  projectLocalGraph,
  projectOrphans,
  projectWorkspaceGraph,
} from "../../../shared/graph/project.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import type { DesktopLinkDatabase } from "../links/DesktopLinkDatabase.js";
import { handleRequest, type IpcMainLike } from "./handler.js";
import { iterateVaultLinkDocuments } from "../links/DesktopLinkIndexer.js";

export interface GraphIndexProvider {
  linksFor(vaultId: string): DesktopLinkDatabase;
}

export interface GraphHandlerDeps extends VaultRootDeps {
  indexes: GraphIndexProvider;
}

async function ensureLinksReady(
  vaultId: string,
  deps: GraphHandlerDeps,
): Promise<DesktopLinkDatabase> {
  const root = await resolveVaultRoot(vaultId, deps);
  const db = deps.indexes.linksFor(vaultId);
  const status = db.getStatus(vaultId);
  if (status.state === "missing") {
    await db.rebuild(
      iterateVaultLinkDocuments({
        vaultId,
        vaultRoot: root.absolutePath,
      }),
    );
  }
  return db;
}

export function registerGraphHandlers(
  bus: IpcMainLike,
  deps: GraphHandlerDeps,
): void {
  bus.handle(
    IPC_CHANNELS.graphNeighborhood,
    handleRequest(
      parseGraphNeighborhoodInput,
      async (input): Promise<GraphProjection> => {
        const db = await ensureLinksReady(input.vaultId, deps);
        const docs = await db.listGraphDocs(input.vaultId);
        const links = await db.listGraphInternalLinks(input.vaultId);
        return projectLocalGraph({
          centerId: input.noteKey,
          depth: input.depth,
          docs,
          links,
          nodeLimit: input.nodeLimit,
          edgeLimit: input.edgeLimit,
          includeBroken: input.includeBroken,
        });
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.graphWorkspace,
    handleRequest(
      parseGraphWorkspaceInput,
      async (input): Promise<GraphProjection> => {
        const db = await ensureLinksReady(input.vaultId, deps);
        const docs = await db.listGraphDocs(input.vaultId);
        const links = await db.listGraphInternalLinks(input.vaultId);
        const orphans = projectOrphans({ docs, links });
        return projectWorkspaceGraph({
          docs,
          links,
          orphanIds: new Set(orphans.map((n) => n.id)),
          nodeLimit: input.nodeLimit,
          edgeLimit: input.edgeLimit,
          filters: input.filters,
        });
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.graphOrphans,
    handleRequest(
      parseGraphOrphansInput,
      async (input): Promise<GraphNode[]> => {
        const db = await ensureLinksReady(input.vaultId, deps);
        const docs = await db.listGraphDocs(input.vaultId);
        const links = await db.listGraphInternalLinks(input.vaultId);
        return projectOrphans({
          docs,
          links,
          limit: input.limit,
        });
      },
    ),
  );
}
