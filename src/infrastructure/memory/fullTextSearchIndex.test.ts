/**
 * InMemoryFullTextSearchIndex 测试（R008 Stage 3 §17.2）：与 Stage 4 的
 * Desktop SQLite 实现共用契约套件，保证参照实现与生产实现语义一致。
 */
import { describeFullTextSearchIndexContract } from "../../test/searchIndexContract";
import { InMemoryFullTextSearchIndex } from "./fullTextSearchIndex";

describeFullTextSearchIndexContract(
  "内存",
  () => new InMemoryFullTextSearchIndex(),
);
