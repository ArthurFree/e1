/**
 * 搜索正确性验收语料（R008 Stage 3 §10.7）：固定文档集 + 固定 query →
 * 期望命中与期望排序。所有 FullTextSearchIndexPort 实现（内存参照 /
 * Stage 4 Desktop SQLite）都必须通过同一组断言（契约套件驱动，
 * 见 src/test/searchIndexContract.ts）。
 *
 * 覆盖维度：中文标题（知识库/部署）、英文大小写（react/REACT/
 * TYPESCRIPT）、tag exact/contains、body-only 命中、空标题回退、
 * emoji、代码文本、snippet 原文大小写保留、跨 vault 合并、limit。
 *
 * 期望排序由契约层可执行语义推出（SEARCH_SCORE 权重 +
 * compareSearchResults 稳定 tie-break），语料变更须同步重推。
 */
import type {
  SearchDocument,
  SearchMatchedField,
} from "../../src/application/services/SearchContract";

export const SEARCH_CORPUS_VAULT_A = "vault-a";
export const SEARCH_CORPUS_VAULT_B = "vault-b";

function corpusDoc(
  pageId: string,
  overrides: Partial<SearchDocument>,
): SearchDocument {
  return {
    pageId,
    vaultId: SEARCH_CORPUS_VAULT_A,
    stableNoteId: `stable-${pageId}`,
    relativePath: `notes/${pageId}.md`,
    title: "",
    tags: [],
    bodyText: "",
    createdAt: 1_757_000_000_000,
    updatedAt: 1_757_000_060_000,
    versionToken: `corpus-v1-${pageId}`,
    ...overrides,
  };
}

export const SEARCH_CORPUS_DOCUMENTS: SearchDocument[] = [
  corpusDoc("c-react-guide", {
    title: "React 性能优化指南",
    tags: ["前端", "react"],
    bodyText:
      "深入 React 渲染性能：memo、useMemo 与列表虚拟化。性能预算需在评审中明确。",
  }),
  corpusDoc("c-react-notes", {
    title: "React 读书笔记",
    tags: ["笔记"],
    bodyText: "组件化与单向数据流的心得。",
  }),
  corpusDoc("c-deploy-manual", {
    title: "部署手册",
    tags: ["运维", "部署"],
    bodyText: "部署前确认环境变量与健康检查。",
  }),
  corpusDoc("c-deploy-checklist", {
    title: "上线检查单",
    tags: ["运维"],
    bodyText: "上线前确认部署脚本与回滚方案。",
  }),
  corpusDoc("c-knowledge-design", {
    title: "知识库设计",
    tags: ["knowledge"],
    bodyText: "本地优先知识库的块模型与索引设计。",
  }),
  corpusDoc("c-vite-log", {
    title: "构建优化记录",
    tags: ["工程"],
    bodyText: "React 项目迁移到 Vite 后构建时间显著下降。",
  }),
  corpusDoc("c-weekly", {
    title: "周会纪要",
    tags: ["前端"],
    bodyText: "本周完成搜索面板联调。",
  }),
  corpusDoc("c-emoji", {
    title: "旅行清单 🧳",
    bodyText: "周六出发 🚀，记得带相机。",
  }),
  corpusDoc("c-code", {
    title: "代码片段集",
    tags: ["snippet"],
    bodyText:
      "防抖：function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }",
  }),
  corpusDoc("c-tsconfig", {
    title: "TYPESCRIPT 配置",
    bodyText: "开启 strict 后的 TypeScript 迁移记录。",
  }),
  corpusDoc("c-untitled", {
    title: "",
    bodyText: "无标题文档的正文，包含部署一词。",
  }),
  corpusDoc("c-other-vault", {
    vaultId: SEARCH_CORPUS_VAULT_B,
    title: "React 另一知识库文档",
    bodyText: "另一个 vault 的 React 文档。",
  }),
];

export interface SearchCorpusExpectation {
  pageId: string;
  matchedField: SearchMatchedField;
  /** 期望展示标题（校验空标题回退等）；缺省不校验。 */
  title?: string;
  /** 期望 snippet 包含的原文（保留大小写）；缺省不校验。 */
  snippetIncludes?: string;
}

export interface SearchCorpusQuery {
  id: string;
  query: string;
  /** 缺省表示跨 vault 查询。 */
  vaultId?: string;
  limit?: number;
  /** 完整期望结果（顺序即断言）。 */
  expected: SearchCorpusExpectation[];
}

const REACT_TITLE_HITS: SearchCorpusExpectation[] = [
  { pageId: "c-react-guide", matchedField: "title" },
  { pageId: "c-react-notes", matchedField: "title" },
  { pageId: "c-vite-log", matchedField: "body" },
];

export const SEARCH_CORPUS_QUERIES: SearchCorpusQuery[] = [
  {
    id: "exact-title",
    query: "React 性能优化指南",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [
      {
        pageId: "c-react-guide",
        matchedField: "title",
        title: "React 性能优化指南",
      },
    ],
  },
  {
    id: "case-insensitive-lower",
    query: "react",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: REACT_TITLE_HITS,
  },
  {
    id: "case-insensitive-upper",
    query: "REACT",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: REACT_TITLE_HITS,
  },
  {
    id: "query-trimmed",
    query: "  react  ",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: REACT_TITLE_HITS,
  },
  {
    id: "chinese-title",
    query: "知识库",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [{ pageId: "c-knowledge-design", matchedField: "title" }],
  },
  {
    id: "chinese-across-fields",
    query: "部署",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [
      {
        pageId: "c-deploy-manual",
        matchedField: "title",
        snippetIncludes: "部署",
      },
      {
        pageId: "c-deploy-checklist",
        matchedField: "body",
        snippetIncludes: "部署",
      },
      { pageId: "c-untitled", matchedField: "body", title: "无标题" },
    ],
  },
  {
    id: "tag-exact",
    query: "前端",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [
      { pageId: "c-react-guide", matchedField: "tag" },
      { pageId: "c-weekly", matchedField: "tag" },
    ],
  },
  {
    id: "tag-contains",
    query: "knowle",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [{ pageId: "c-knowledge-design", matchedField: "tag" }],
  },
  {
    id: "english-title-case-insensitive",
    query: "typescript",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [{ pageId: "c-tsconfig", matchedField: "title" }],
  },
  {
    id: "emoji-body",
    query: "🚀",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [{ pageId: "c-emoji", matchedField: "body" }],
  },
  {
    id: "code-body",
    query: "debounce",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [
      { pageId: "c-code", matchedField: "body", snippetIncludes: "debounce" },
    ],
  },
  {
    id: "snippet-preserves-original-case",
    query: "vite",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [
      { pageId: "c-vite-log", matchedField: "body", snippetIncludes: "Vite" },
    ],
  },
  {
    id: "empty-query",
    query: "",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [],
  },
  {
    id: "blank-query",
    query: "   ",
    vaultId: SEARCH_CORPUS_VAULT_A,
    expected: [],
  },
  {
    id: "cross-vault-merge",
    query: "react",
    expected: [
      { pageId: "c-other-vault", matchedField: "title" },
      ...REACT_TITLE_HITS,
    ],
  },
  {
    id: "limit-truncates",
    query: "react",
    vaultId: SEARCH_CORPUS_VAULT_A,
    limit: 2,
    expected: REACT_TITLE_HITS.slice(0, 2),
  },
];
