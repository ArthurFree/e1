// @vitest-environment node
/**
 * R010 Stage 3：DesktopLinkDatabase（node:sqlite）跑 LinkIndex 契约套件——
 * 与内存参照实现同一组语义断言。upsert 的「读盘」由适配层的 disk Map
 * 扮演（生产侧由 IPC handler 经 readNoteFile 供给，DSK-02）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LinkIndex,
  LinkIndexDocument,
} from "../../../shared/links/LinkIndex.js";
import { runLinkIndexContract } from "../../../shared/links/linkIndexContract.js";
import { DesktopLinkDatabase } from "./DesktopLinkDatabase.js";

let disk: Map<string, LinkIndexDocument>;

function diskKey(vaultId: string, relativePath: string): string {
  return `${vaultId}::${relativePath}`;
}

/** DB 类 → LinkIndex 端口形状的薄适配（生产侧由 IPC/Indexer 驱动）。 */
function adapt(db: DesktopLinkDatabase): LinkIndex {
  return {
    prepare: () => Promise.resolve(),
    rebuild: (_vaultId: string, documents) =>
      db.rebuild(documents as Iterable<LinkIndexDocument>),
    upsert: async ({ vaultId, relativePath }) => {
      const document = disk.get(diskKey(vaultId, relativePath));
      if (!document) return { indexed: false };
      await db.upsertDocument(document);
      return { indexed: true };
    },
    remove: ({ vaultId, noteKey, relativePath }) =>
      noteKey ? db.remove(noteKey) : db.removeByPath(vaultId, relativePath!),
    relocate: (input) => db.relocate(input),
    getOutgoing: ({ vaultId, noteKey }) => db.getOutgoing(vaultId, noteKey),
    getBacklinks: ({ vaultId, noteKey }) => db.getBacklinks(vaultId, noteKey),
    getBrokenLinks: (vaultId) => db.getBrokenLinks(vaultId),
    getStatus: (vaultId) => db.getStatus(vaultId),
  };
}

runLinkIndexContract("DesktopLinkDatabase", {
  createIndex: () => {
    disk = new Map();
    const dir = mkdtempSync(join(tmpdir(), "e1-link-contract-"));
    return adapt(new DesktopLinkDatabase(join(dir, "index.sqlite")));
  },
  rebuild: (index: LinkIndex, docs: LinkIndexDocument[]) =>
    index.rebuild("v-contract", docs),
  putDocument: (document) => {
    disk.set(diskKey(document.vaultId, document.relativePath), document);
  },
  removeDocument: (vaultId, relativePath) => {
    disk.delete(diskKey(vaultId, relativePath));
  },
});
