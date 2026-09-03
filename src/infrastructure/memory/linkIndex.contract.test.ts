/**
 * R010 Stage 3：内存参照实现跑 LinkIndex 契约套件。
 */
import type {
  LinkIndex,
  LinkIndexDocument,
} from "../../../shared/links/LinkIndex";
import { runLinkIndexContract } from "../../../shared/links/linkIndexContract";
import { InMemoryLinkIndex } from "./linkIndex";

/** 当前用例的「磁盘」（createIndex 时重建，put/removeDocument 维护）。 */
let disk: Map<string, LinkIndexDocument>;

function diskKey(vaultId: string, relativePath: string): string {
  return `${vaultId}::${relativePath}`;
}

runLinkIndexContract("InMemoryLinkIndex", {
  createIndex: (): LinkIndex => {
    disk = new Map();
    return new InMemoryLinkIndex({
      read: (vaultId, relativePath) =>
        disk.get(diskKey(vaultId, relativePath)) ?? null,
    });
  },
  rebuild: (index, docs) => index.rebuild("v-contract", docs),
  putDocument: (document) => {
    disk.set(diskKey(document.vaultId, document.relativePath), document);
  },
  removeDocument: (vaultId, relativePath) => {
    disk.delete(diskKey(vaultId, relativePath));
  },
});
