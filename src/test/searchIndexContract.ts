/**
 * FullTextSearchIndexPort 契约套件（R008 Stage 3 §17.2）：内存参照实现
 * 与 Stage 4 的 Desktop SQLite 实现共用同一组行为断言，保证两实现
 * 语义一致（参照 recoveryStoreContract / assetStoreContract 模式）。
 *
 * 覆盖：
 * - upsert 幂等 / 同 pageId 覆盖后旧文本立即消失；
 * - remove 幂等；
 * - query 确定性（与插入顺序无关，多实例重放一致）；
 * - rebuild 后结果与重建前一致；
 * - 查询规则（§10.6）：trim、空串空结果、大小写不敏感、中文/Unicode、
 *   title > tag > body 权重、同分稳定排序、limit 上限 100；
 * - vault 隔离与跨 vault 合并；
 * - getStatus 状态机（missing → ready）；
 * - 验收语料（fixtures/search/corpus.ts）全量断言。
 */
import { describe, expect, it } from "vitest";
import {
  SEARCH_CORPUS_DOCUMENTS,
  SEARCH_CORPUS_QUERIES,
  SEARCH_CORPUS_VAULT_A,
  SEARCH_CORPUS_VAULT_B,
} from "../../fixtures/search/corpus";
import type { SearchCorpusExpectation } from "../../fixtures/search/corpus";
import type {
  FullTextSearchIndexPort,
  SearchDocument,
  SearchResult,
} from "../application/services/SearchContract";
import { SEARCH_LIMIT_MAX } from "../application/services/SearchContract";

function doc(
  pageId: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return {
    pageId,
    vaultId: SEARCH_CORPUS_VAULT_A,
    stableNoteId: null,
    relativePath: `notes/${pageId}.md`,
    title: "",
    tags: [],
    bodyText: "",
    createdAt: null,
    updatedAt: null,
    versionToken: `v1-${pageId}`,
    ...overrides,
  };
}

function ids(results: SearchResult[]): string[] {
  return results.map((r) => r.pageId);
}

function expectResults(
  results: SearchResult[],
  expected: SearchCorpusExpectation[],
): void {
  expect(ids(results)).toEqual(expected.map((e) => e.pageId));
  for (const [i, expectation] of expected.entries()) {
    expect(results[i].matchedField).toBe(expectation.matchedField);
    if (expectation.title !== undefined) {
      expect(results[i].title).toBe(expectation.title);
    }
    if (expectation.snippetIncludes !== undefined) {
      expect(results[i].snippet).toContain(expectation.snippetIncludes);
    }
  }
}

export function describeFullTextSearchIndexContract(
  name: string,
  makeIndex: () => FullTextSearchIndexPort | Promise<FullTextSearchIndexPort>,
): void {
  /** 新实例 + 已 prepare 的 vault-a。 */
  async function preparedIndex(): Promise<FullTextSearchIndexPort> {
    const index = await makeIndex();
    await index.prepareWorkspace(SEARCH_CORPUS_VAULT_A);
    return index;
  }

  describe(`FullTextSearchIndex 契约（${name}）`, () => {
    it("upsert 后按标题可搜索；空查询与纯空白返回空", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { title: "部署手册" }));
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "部署", limit: 10 })),
      ).toEqual(["p1"]);
      expect(
        await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "", limit: 10 }),
      ).toEqual([]);
      expect(
        await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "   ", limit: 10 }),
      ).toEqual([]);
    });

    it("查询先 trim 且大小写不敏感", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { title: "React Performance" }));
      for (const query of ["react", "REACT", " React ", "rEaCt"]) {
        expect(
          ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query, limit: 10 })),
        ).toEqual(["p1"]);
      }
    });

    it("中文与 Unicode（含 emoji）查询可命中", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { bodyText: "本地优先知识库，周六出发 🚀" }));
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "知识库", limit: 10 })),
      ).toEqual(["p1"]);
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "🚀", limit: 10 })),
      ).toEqual(["p1"]);
    });

    it("权重排序：title > tag > body", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p-body", { bodyText: "正文里的 tokenxyz" }));
      await index.upsert(doc("p-tag", { tags: ["tokenxyz"] }));
      await index.upsert(doc("p-title", { title: "tokenxyz 文档" }));
      const results = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "tokenxyz",
        limit: 10,
      });
      expect(ids(results)).toEqual(["p-title", "p-tag", "p-body"]);
      expect(results.map((r) => r.matchedField)).toEqual([
        "title",
        "tag",
        "body",
      ]);
    });

    it("同分结果排序稳定，与插入顺序无关", async () => {
      // 三个 title contains 同分文档；确定性顺序由标题码元升序决定。
      const build = async (insertOrder: string[]): Promise<string[]> => {
        const index = await preparedIndex();
        for (const title of insertOrder) {
          await index.upsert(doc(`p-${title}`, { title }));
        }
        return ids(
          await index.search({
            vaultId: SEARCH_CORPUS_VAULT_A,
            query: "abc",
            limit: 10,
          }),
        );
      };
      const forward = await build(["1abc", "10abc", "2abc"]);
      const reversed = await build(["2abc", "10abc", "1abc"]);
      expect(forward).toEqual(["p-10abc", "p-1abc", "p-2abc"]);
      expect(reversed).toEqual(forward);
    });

    it("upsert 幂等：重复 upsert 同一文档不产生重复结果", async () => {
      const index = await preparedIndex();
      const document = doc("p1", { title: "部署手册" });
      await index.upsert(document);
      await index.upsert(document);
      await index.upsert({ ...document });
      const results = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "部署",
        limit: 10,
      });
      expect(ids(results)).toEqual(["p1"]);
    });

    it("upsert 同 pageId 覆盖：旧文本立即消失、新文本可搜", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { bodyText: "旧文本 alpha-old" }));
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "alpha-old", limit: 10 })),
      ).toEqual(["p1"]);
      await index.upsert(
        doc("p1", { bodyText: "新文本 beta-new", versionToken: "v2-p1" }),
      );
      expect(
        await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "alpha-old", limit: 10 }),
      ).toEqual([]);
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "beta-new", limit: 10 })),
      ).toEqual(["p1"]);
    });

    it("remove 幂等：移除后搜不到，重复 remove 不报错", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { title: "部署手册" }));
      await index.remove({ vaultId: SEARCH_CORPUS_VAULT_A, pageId: "p1" });
      expect(
        await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "部署", limit: 10 }),
      ).toEqual([]);
      // 对缺失条目与未知 vault 均为 no-op。
      await index.remove({ vaultId: SEARCH_CORPUS_VAULT_A, pageId: "p1" });
      await index.remove({ vaultId: "vault-unknown", pageId: "p1" });
    });

    it("rebuild 后查询结果与重建前一致", async () => {
      const index = await preparedIndex();
      await index.upsert(doc("p1", { title: "共同词 标题" }));
      await index.upsert(doc("p2", { tags: ["共同词"] }));
      await index.upsert(doc("p3", { bodyText: "正文包含共同词" }));
      const before = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "共同词",
        limit: 10,
      });
      const rebuilt = await index.rebuild(SEARCH_CORPUS_VAULT_A);
      expect(rebuilt.indexedDocuments).toBe(3);
      const after = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "共同词",
        limit: 10,
      });
      expect(after).toEqual(before);
    });

    it("limit 上限 100 且按请求截断", async () => {
      const index = await preparedIndex();
      for (let i = 0; i < 150; i++) {
        await index.upsert(doc(`bulk-${i}`, { bodyText: "bulkterm 正文" }));
      }
      const capped = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "bulkterm",
        limit: 1000,
      });
      expect(capped).toHaveLength(SEARCH_LIMIT_MAX);
      const truncated = await index.search({
        vaultId: SEARCH_CORPUS_VAULT_A,
        query: "bulkterm",
        limit: 5,
      });
      expect(truncated).toHaveLength(5);
      expect(
        await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "bulkterm", limit: 0 }),
      ).toEqual([]);
    });

    it("vault 隔离：指定 vaultId 不返回其他 vault 文档", async () => {
      const index = await preparedIndex();
      await index.prepareWorkspace(SEARCH_CORPUS_VAULT_B);
      await index.upsert(doc("a1", { title: "共享词 甲" }));
      await index.upsert(
        doc("b1", { vaultId: SEARCH_CORPUS_VAULT_B, title: "共享词 乙" }),
      );
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_A, query: "共享词", limit: 10 })),
      ).toEqual(["a1"]);
      expect(
        ids(await index.search({ vaultId: SEARCH_CORPUS_VAULT_B, query: "共享词", limit: 10 })),
      ).toEqual(["b1"]);
    });

    it("省略 vaultId 时跨 vault 合并并按全局得分排序", async () => {
      const index = await preparedIndex();
      await index.prepareWorkspace(SEARCH_CORPUS_VAULT_B);
      await index.upsert(doc("a-body", { bodyText: "正文里的共享词" }));
      await index.upsert(
        doc("b-title", { vaultId: SEARCH_CORPUS_VAULT_B, title: "共享词 标题" }),
      );
      const results = await index.search({ query: "共享词", limit: 10 });
      expect(ids(results)).toEqual(["b-title", "a-body"]);
    });

    it("getStatus：missing → ready，rebuild 返回索引计数", async () => {
      const index = await makeIndex();
      expect(await index.getStatus(SEARCH_CORPUS_VAULT_A)).toEqual({
        state: "missing",
      });
      await index.prepareWorkspace(SEARCH_CORPUS_VAULT_A);
      expect(await index.getStatus(SEARCH_CORPUS_VAULT_A)).toEqual({
        state: "ready",
        indexedDocuments: 0,
      });
      // prepareWorkspace 幂等。
      await index.prepareWorkspace(SEARCH_CORPUS_VAULT_A);
      await index.upsert(doc("p1", { title: "甲" }));
      await index.upsert(doc("p2", { title: "乙" }));
      expect(await index.getStatus(SEARCH_CORPUS_VAULT_A)).toEqual({
        state: "ready",
        indexedDocuments: 2,
      });
      const rebuilt = await index.rebuild(SEARCH_CORPUS_VAULT_A);
      expect(rebuilt.indexedDocuments).toBe(2);
      expect(await index.getStatus(SEARCH_CORPUS_VAULT_A)).toEqual({
        state: "ready",
        indexedDocuments: 2,
      });
    });

    it("验收语料：固定 query 的命中、字段与排序全部符合预期", async () => {
      const index = await preparedIndex();
      await index.prepareWorkspace(SEARCH_CORPUS_VAULT_B);
      for (const document of SEARCH_CORPUS_DOCUMENTS) {
        await index.upsert(document);
      }
      for (const corpusQuery of SEARCH_CORPUS_QUERIES) {
        const results = await index.search({
          vaultId: corpusQuery.vaultId,
          query: corpusQuery.query,
          limit: corpusQuery.limit ?? SEARCH_LIMIT_MAX,
        });
        expectResults(results, corpusQuery.expected);
      }
    });
  });
}
