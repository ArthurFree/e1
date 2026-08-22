/**
 * R008 Stage 3：内存参照实现跑 FullTextSearchIndex 契约套件。
 */
import { InMemoryFullTextSearchIndex } from "./fullTextSearchIndex";
import { runFullTextSearchContract } from "../../../shared/search/fullTextSearchContract";

runFullTextSearchContract("InMemoryFullTextSearchIndex", {
  createIndex: () => new InMemoryFullTextSearchIndex(),
  rebuild: (index, docs) => index.rebuild("v-contract", docs),
});
