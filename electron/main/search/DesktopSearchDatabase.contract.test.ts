// @vitest-environment node
/**
 * R008 Stage 4：DesktopSearchDatabase（node:sqlite FTS5）跑
 * FullTextSearchIndex 契约套件——与内存参照实现同一组语义断言。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FullTextSearchIndex,
  SearchDocument,
} from "../../../shared/search/FullTextSearchIndex.js";
import { runFullTextSearchContract } from "../../../shared/search/fullTextSearchContract.js";
import { DesktopSearchDatabase } from "./DesktopSearchDatabase.js";

/** DB 类 → FullTextSearchIndex 端口形状的薄适配（生产侧由 IPC/Indexer 驱动）。 */
function adapt(db: DesktopSearchDatabase): FullTextSearchIndex {
  return {
    prepare: () => Promise.resolve(),
    rebuild: (_vaultId: string, documents) =>
      db.rebuild(documents as Iterable<SearchDocument>),
    search: (input) => db.search(input),
    upsert: (document) => db.upsert(document),
    remove: ({ pageId }) => db.remove(pageId),
    relocate: ({ pageId, relativePath }) => db.relocate(pageId, relativePath),
    getStatus: (vaultId) => db.getStatus(vaultId),
  };
}

runFullTextSearchContract("DesktopSearchDatabase", {
  createIndex: () => {
    const dir = mkdtempSync(join(tmpdir(), "e1-search-contract-"));
    return adapt(new DesktopSearchDatabase(join(dir, "index.sqlite")));
  },
  rebuild: (index: FullTextSearchIndex, docs: SearchDocument[]) =>
    index.rebuild("v-contract", docs),
});
