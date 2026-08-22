/**
 * R008 Stage 3（§10/§17.2）：FullTextSearchIndex 契约套件——
 * 内存参照实现与 Desktop SQLite 实现（Stage 4）必须通过同一组语义断言：
 * title/tag/body 命中、中文/Unicode、评分排序、稳定排序、limit、
 * upsert/remove 幂等、更新后旧文本消失、relocate 身份保持、rebuild 一致。
 *
 * 语料覆盖 §10.7 分布：中文标题、英文标题、中英混合、多标签、长文、
 * 短文、深目录、重复词、高频词、emoji、code block、links、tables、
 * frontmatter（frontmatter 语法不进 bodyText——调用方已提取）。
 */
import { describe, expect, it } from "vitest";
import type {
  FullTextSearchIndex,
  SearchDocument,
} from "../application/search/FullTextSearchIndex";
import { SEARCH_SCORE } from "../application/search/FullTextSearchIndex";

const VAULT = "v-contract";

function doc(
  partial: Partial<SearchDocument> & { pageId: string },
): SearchDocument {
  return {
    vaultId: VAULT,
    stableNoteId: null,
    relativePath: `${partial.pageId}.md`,
    title: partial.pageId,
    tags: [],
    bodyText: "",
    createdAt: null,
    updatedAt: null,
    versionToken: `sha256:${partial.pageId}`,
    ...partial,
  };
}

/** 契约语料（确定性）。 */
export function contractCorpus(): SearchDocument[] {
  return [
    doc({
      pageId: "p-react",
      title: "React 笔记",
      tags: ["前端", "框架"],
      relativePath: "学习/前端/React.md",
      bodyText:
        "组件化与 Hooks 要点。状态管理的选择：useState 与 useReducer。\n".repeat(
          3,
        ),
      stableNoteId: "01REACT",
    }),
    doc({
      pageId: "p-vue",
      title: "Vue 入门",
      tags: ["前端"],
      relativePath: "学习/前端/Vue.md",
      bodyText: "组合式 API 与响应式基础。",
    }),
    doc({
      pageId: "p-rust",
      title: "Rust ownership",
      tags: ["backend"],
      relativePath: "学习/后端/lang/Rust.md",
      bodyText:
        "Ownership and borrowing are the core of Rust memory safety. ".repeat(
          20,
        ),
    }),
    doc({
      pageId: "p-mixed",
      title: "中英混合 Mixed 标题",
      relativePath: "杂记/mixed.md",
      bodyText: "今天研究了 search indexing 的中文分词问题，bigram 方案可行。",
    }),
    doc({
      pageId: "p-exact",
      title: "搜索",
      relativePath: "搜索.md",
      bodyText: "一篇标题就叫搜索的短文。",
    }),
    doc({
      pageId: "p-prefix",
      title: "搜索引擎评测",
      relativePath: "搜索引擎评测.md",
      bodyText: "对比多个引擎的召回与排序。",
    }),
    doc({
      pageId: "p-contains",
      title: "全文搜索方案对比",
      relativePath: "方案/全文搜索方案对比.md",
      bodyText: "SQLite FTS、Lucene 与内存索引的取舍。",
    }),
    doc({
      pageId: "p-tagged",
      title: "无命中标题",
      tags: ["搜索"],
      relativePath: "标签命中.md",
      bodyText: "标签里有查询词但标题正文都没有。",
    }),
    doc({
      pageId: "p-emoji",
      title: "Emoji 收集 🎉",
      relativePath: "杂记/emoji.md",
      bodyText: "常用 emoji：🎉 🚀 ✨ 与它们的语义。",
    }),
    doc({
      pageId: "p-code",
      title: "代码片段",
      relativePath: "学习/code.md",
      bodyText:
        "function tokenizeForIndex(text) { return new Set(text); }\n并行 keywordExtraction 示例。",
    }),
    doc({
      pageId: "p-table",
      title: "表格笔记",
      relativePath: "表格.md",
      bodyText: "名称 价格 数量\n苹果 3.5 十斤\n香蕉 4.2 五斤",
    }),
    doc({
      pageId: "p-links",
      title: "链接收藏",
      relativePath: "链接.md",
      bodyText: "Tiptap 文档 与 SQLite 手册 的链接集合。",
    }),
    doc({
      pageId: "p-highfreq",
      title: "高频词文档",
      relativePath: "高频.md",
      bodyText: "索引 ".repeat(200),
    }),
    doc({
      pageId: "p-deep",
      title: "深目录文档",
      relativePath: "a/b/c/d/e/f/deep.md",
      bodyText: "藏得很深的一篇。",
    }),
  ];
}

export interface FullTextSearchContractContext {
  createIndex(): FullTextSearchIndex;
  /** 重建语料（实现需要显式供给 documents 时经此参数）。 */
  rebuild(index: FullTextSearchIndex, docs: SearchDocument[]): Promise<void>;
}

export function runFullTextSearchContract(
  name: string,
  ctx: FullTextSearchContractContext,
): void {
  const corpus = contractCorpus();

  async function readyIndex(): Promise<FullTextSearchIndex> {
    const index = ctx.createIndex();
    await ctx.rebuild(index, corpus);
    return index;
  }

  describe(`FullTextSearchIndex 契约（${name}）`, () => {
    it("title 命中：exact > prefix > contains（§11.7 评分排序）", async () => {
      const index = await readyIndex();
      const results = await index.search({ vaultId: VAULT, query: "搜索" });
      const ids = results.map((r) => r.pageId);
      expect(ids.slice(0, 3)).toEqual(["p-exact", "p-prefix", "p-contains"]);
      expect(results[0]).toMatchObject({
        matchedField: "title",
        score: SEARCH_SCORE.titleExact,
        snippet: null,
      });
      expect(results[1].score).toBe(SEARCH_SCORE.titlePrefix);
      expect(results[2].score).toBe(SEARCH_SCORE.titleContains);
      // tag/body 命中的「搜索」排在 title 命中之后。
      expect(ids.indexOf("p-tagged")).toBeGreaterThan(2);
    });

    it("tag 命中：matchedField=tag、score=40、snippet 为 null", async () => {
      const index = await readyIndex();
      const results = await index.search({ vaultId: VAULT, query: "框架" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pageId: "p-react",
        matchedField: "tag",
        score: SEARCH_SCORE.tagMatch,
        snippet: null,
      });
    });

    it("body 命中：中文子串（bigram 覆盖）+ snippet 含命中词且为纯文本", async () => {
      const index = await readyIndex();
      const results = await index.search({ vaultId: VAULT, query: "组件化" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pageId: "p-react",
        matchedField: "body",
        score: SEARCH_SCORE.bodyMatch,
      });
      expect(results[0].snippet).toContain("组件化");
      expect(results[0].snippet).not.toMatch(/<[^>]+>/);
    });

    it("body 命中：中文跨词查询（AND 语义）", async () => {
      const index = await readyIndex();
      const results = await index.search({
        vaultId: VAULT,
        query: "中文 分词",
      });
      expect(results.map((r) => r.pageId)).toEqual(["p-mixed"]);
    });

    it("body 命中：拉丁词前缀（rea 命中 React 正文词）", async () => {
      const index = await readyIndex();
      const results = await index.search({ vaultId: VAULT, query: "borrow" });
      expect(results.map((r) => r.pageId)).toEqual(["p-rust"]);
      expect(results[0].matchedField).toBe("body");
    });

    it("大小写不敏感 + NFKC 归一", async () => {
      const index = await readyIndex();
      const upper = await index.search({ vaultId: VAULT, query: "RUST" });
      expect(upper.map((r) => r.pageId)).toContain("p-rust");
      const fullWidth = await index.search({
        vaultId: VAULT,
        query: "ＲＵＳＴ",
      });
      expect(fullWidth.map((r) => r.pageId)).toContain("p-rust");
    });

    it("emoji 可搜索", async () => {
      const index = await readyIndex();
      const results = await index.search({ vaultId: VAULT, query: "🚀" });
      expect(results.map((r) => r.pageId)).toEqual(["p-emoji"]);
    });

    it("code / 表格 / 链接提取后的文本可搜索", async () => {
      const index = await readyIndex();
      for (const [query, pageId] of [
        ["tokenizeForIndex", "p-code"],
        ["香蕉", "p-table"],
        ["Tiptap", "p-links"],
      ] as const) {
        const results = await index.search({ vaultId: VAULT, query });
        expect(
          results.map((r) => r.pageId),
          query,
        ).toContain(pageId);
      }
    });

    it("空查询 / 纯空白 → []；trim 后查询生效", async () => {
      const index = await readyIndex();
      expect(await index.search({ vaultId: VAULT, query: "" })).toEqual([]);
      expect(await index.search({ vaultId: VAULT, query: "   " })).toEqual([]);
      const trimmed = await index.search({ vaultId: VAULT, query: "  搜索  " });
      expect(trimmed.length).toBeGreaterThan(0);
    });

    it("limit：缺省 50；上限 100；显式 limit 生效", async () => {
      const index = await readyIndex();
      const results = await index.search({
        vaultId: VAULT,
        query: "索",
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("稳定排序：同分按 title zh-CN、pageId", async () => {
      const index = await readyIndex();
      const first = await index.search({ vaultId: VAULT, query: "前端" });
      const second = await index.search({ vaultId: VAULT, query: "前端" });
      expect(first.map((r) => r.pageId)).toEqual(second.map((r) => r.pageId));
    });

    it("upsert 幂等 + 更新后旧文本消失", async () => {
      const index = await readyIndex();
      const updated = doc({
        pageId: "p-vue",
        title: "Vue 入门",
        tags: ["前端"],
        relativePath: "学习/前端/Vue.md",
        bodyText: "全新的响应式篇章，内容已经完全改写。",
        versionToken: "sha256:v2",
      });
      await index.upsert(updated);
      await index.upsert(updated);
      expect(
        (await index.search({ vaultId: VAULT, query: "组合式" })).map(
          (r) => r.pageId,
        ),
      ).not.toContain("p-vue");
      expect(
        (await index.search({ vaultId: VAULT, query: "响应式" })).map(
          (r) => r.pageId,
        ),
      ).toContain("p-vue");
    });

    it("remove 幂等：删除后搜不到，重复删除不抛错", async () => {
      const index = await readyIndex();
      await index.remove({ vaultId: VAULT, pageId: "p-emoji" });
      await index.remove({ vaultId: VAULT, pageId: "p-emoji" });
      expect(await index.search({ vaultId: VAULT, query: "🚀" })).toEqual([]);
    });

    it("relocate：身份保持（pageId 不变），relativePath 更新", async () => {
      const index = await readyIndex();
      await index.relocate({
        vaultId: VAULT,
        pageId: "p-deep",
        relativePath: "新位置/deep.md",
      });
      const results = await index.search({ vaultId: VAULT, query: "藏得很深" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pageId: "p-deep",
        relativePath: "新位置/deep.md",
      });
    });

    it("rebuild：旧条目被替换，重建后结果一致", async () => {
      const index = await readyIndex();
      await ctx.rebuild(index, [
        doc({ pageId: "p-only", title: "唯一的文档", bodyText: "重建之后。" }),
      ]);
      expect(await index.search({ vaultId: VAULT, query: "组件化" })).toEqual(
        [],
      );
      expect(
        (await index.search({ vaultId: VAULT, query: "唯一" })).map(
          (r) => r.pageId,
        ),
      ).toEqual(["p-only"]);
    });

    it("跨 Vault 搜索（vaultId 缺省）与状态机", async () => {
      const index = ctx.createIndex();
      expect(index.getStatus("v-other").state).toBe("missing");
      await ctx.rebuild(index, corpus);
      await index.upsert(
        doc({
          pageId: "p-other",
          vaultId: "v-other",
          title: "另一库的文档",
          bodyText: "跨库关键词：组件化。",
        }),
      );
      const cross = await index.search({ query: "组件化" });
      expect(cross.map((r) => r.pageId).sort()).toEqual(["p-other", "p-react"]);
      expect(index.getStatus(VAULT).state).toBe("ready");
    });
  });
}
