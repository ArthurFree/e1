/**
 * 搜索 benchmark 语料生成器（R008 Stage 3 §10.7）：确定性程序生成
 * 1k / 10k / 50k 规模文档（50k 不提交实体，全部经本生成器参数化产出）。
 *
 * - 确定性：mulberry32 PRNG，固定默认 seed（DEFAULT_SEARCH_CORPUS_SEED），
 *   同 seed + 同 count 产出逐字节一致；
 * - 分布覆盖 §10.7 全部维度：中文标题 / 英文标题 / 中英混合 / 多标签 /
 *   长文 / 短文 / 深目录 / 重复词 / 高频词 / emoji / code block /
 *   links / tables / frontmatter（每篇均带 frontmatter）；
 * - 每篇产出 markdown 原文与 SearchDocument 双形态，bodyText 经
 *   shared/markdown/searchText.ts 真实提取，保证 benchmark 走完整
 *   「Markdown → searchable text → 索引」链路。
 */
import { markdownToSearchText } from "../../shared/markdown/searchText";
import type { SearchDocument } from "../../src/application/services/SearchContract";

export const DEFAULT_SEARCH_CORPUS_SEED = 20260821;
export const DEFAULT_SEARCH_VAULT_ID = "bench-vault";

/** mulberry32：确定性 PRNG（同 seed 序列一致）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rand() * pool.length)];
}

const CHINESE_TITLES = [
  "知识库设计",
  "部署手册",
  "读书笔记",
  "会议纪要",
  "产品方案",
  "性能优化清单",
] as const;
const ENGLISH_TITLES = [
  "React Performance",
  "Deployment Guide",
  "Design Notes",
  "Weekly Sync",
  "Build Pipeline",
] as const;
const MIXED_TITLES = [
  "React 实战笔记",
  "Vite 构建优化",
  "SQLite 搜索方案",
  "Tiptap 编辑器扩展",
] as const;
const TAG_POOL = [
  "工程",
  "前端",
  "react",
  "部署",
  "knowledge",
  "性能",
  "笔记",
  "backend",
] as const;
const CHINESE_SENTENCES = [
  "本地优先的知识库需要可重建的派生索引。",
  "部署前必须确认回滚方案与健康检查。",
  "性能优化先测量再动手，避免过早优化。",
  "会议纪要要记录结论与行动项。",
  "搜索排序需要稳定且可解释。",
] as const;
const ENGLISH_SENTENCES = [
  "React rendering performance depends on memoization.",
  "SQLite FTS provides fast full text queries.",
  "A deterministic benchmark requires a fixed seed.",
  "Markdown remains the source of truth.",
] as const;
/** 高频词：约 1/3 文档的正文额外包含其中一个，模拟真实词频倾斜。 */
const HIGH_FREQUENCY_TOKENS = ["性能", "React", "知识库", "部署"] as const;
const EMOJI_POOL = ["🧳", "🚀", "📚", "🛠️", "🎯"] as const;

/** 语料原型（i % 12 轮转），与 §10.7 维度一一对应。 */
const ARCHETYPE = {
  chineseTitle: 0,
  englishTitle: 1,
  mixedTitle: 2,
  multiTag: 3,
  longBody: 4,
  shortBody: 5,
  deepDirectory: 6,
  repeatedWord: 7,
  highFrequency: 8,
  emoji: 9,
  codeBlock: 10,
  linksTables: 11,
} as const;

export interface GeneratedSearchNote {
  document: SearchDocument;
  /** 产生 document.bodyText 的 Markdown 原文（含 frontmatter）。 */
  markdown: string;
}

export interface GenerateSearchCorpusOptions {
  seed?: number;
  vaultId?: string;
}

function buildBodyMarkdown(
  archetype: number,
  rand: () => number,
  index: number,
): string {
  switch (archetype) {
    case ARCHETYPE.longBody: {
      const paragraphs: string[] = [];
      for (let i = 0; i < 40; i++) {
        paragraphs.push(
          rand() < 0.5
            ? pick(rand, CHINESE_SENTENCES)
            : pick(rand, ENGLISH_SENTENCES),
        );
      }
      return paragraphs.join("\n\n");
    }
    case ARCHETYPE.shortBody:
      return pick(rand, CHINESE_SENTENCES);
    case ARCHETYPE.repeatedWord:
      return Array.from({ length: 50 }, () => "防抖").join(" ");
    case ARCHETYPE.highFrequency:
      return `${pick(rand, HIGH_FREQUENCY_TOKENS)}专题：${pick(rand, CHINESE_SENTENCES)}`;
    case ARCHETYPE.emoji:
      return `清单 ${pick(rand, EMOJI_POOL)}：出发 ${pick(rand, EMOJI_POOL)} 记录 ${pick(rand, EMOJI_POOL)}`;
    case ARCHETYPE.codeBlock:
      return [
        "工具函数集：",
        "",
        "```ts",
        `export function debounce${index}(fn: () => void, ms: number) {`,
        "  let t: number | undefined;",
        "  return () => { clearTimeout(t); t = setTimeout(fn, ms); };",
        "}",
        "```",
      ].join("\n");
    case ARCHETYPE.linksTables:
      return [
        "参考[部署文档](https://example.com/deploy)与[架构图](https://example.com/arch)。",
        "",
        "| 环境 | 地址 |",
        "| --- | --- |",
        "| 生产 | https://example.com |",
        "| 预发 | https://staging.example.com |",
      ].join("\n");
    default: {
      const sentences: string[] = [];
      const count = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < count; i++) {
        sentences.push(
          rand() < 0.5
            ? pick(rand, CHINESE_SENTENCES)
            : pick(rand, ENGLISH_SENTENCES),
        );
      }
      // 高频词倾斜：约 1/3 文档额外包含一个高频词。
      if (rand() < 0.35) sentences.push(`关键词：${pick(rand, HIGH_FREQUENCY_TOKENS)}。`);
      return sentences.join("\n\n");
    }
  }
}

function buildTitle(
  archetype: number,
  rand: () => number,
  index: number,
): string {
  switch (archetype) {
    case ARCHETYPE.chineseTitle:
      return `${pick(rand, CHINESE_TITLES)} ${index}`;
    case ARCHETYPE.englishTitle:
      return `${pick(rand, ENGLISH_TITLES)} ${index}`;
    case ARCHETYPE.mixedTitle:
      return `${pick(rand, MIXED_TITLES)} ${index}`;
    case ARCHETYPE.emoji:
      return `清单 ${pick(rand, EMOJI_POOL)} ${index}`;
    default:
      return rand() < 0.5
        ? `${pick(rand, CHINESE_TITLES)} ${index}`
        : `${pick(rand, ENGLISH_TITLES)} ${index}`;
  }
}

function buildTags(archetype: number, rand: () => number): string[] {
  if (archetype === ARCHETYPE.multiTag) {
    return [...TAG_POOL].sort(() => rand() - 0.5).slice(0, 5);
  }
  const count = Math.floor(rand() * 3);
  const tags = new Set<string>();
  while (tags.size < count) tags.add(pick(rand, TAG_POOL));
  return [...tags];
}

function buildRelativePath(
  archetype: number,
  rand: () => number,
  index: number,
): string {
  if (archetype === ARCHETYPE.deepDirectory) {
    return `areas/area-${index % 7}/projects/proj-${index % 13}/notes/2026/08/note-${index}.md`;
  }
  return rand() < 0.3
    ? `topics/topic-${index % 11}/note-${index}.md`
    : `notes/note-${index}.md`;
}

/** 生成 count 篇确定性语料（markdown + SearchDocument 双形态）。 */
export function generateSearchCorpus(
  count: number,
  options: GenerateSearchCorpusOptions = {},
): GeneratedSearchNote[] {
  const seed = options.seed ?? DEFAULT_SEARCH_CORPUS_SEED;
  const vaultId = options.vaultId ?? DEFAULT_SEARCH_VAULT_ID;
  const rand = mulberry32(seed);
  const baseTime = 1_757_000_000_000;
  const notes: GeneratedSearchNote[] = [];
  for (let i = 0; i < count; i++) {
    const archetype = i % 12;
    const pageId = `gen-${i.toString().padStart(6, "0")}`;
    const title = buildTitle(archetype, rand, i);
    const tags = buildTags(archetype, rand);
    const bodyMarkdown = buildBodyMarkdown(archetype, rand, i);
    const createdAt = baseTime + i * 60_000;
    const updatedAt = createdAt + Math.floor(rand() * 86_400_000);
    const versionToken = `gen-${seed}-${i}-${Math.floor(rand() * 0xffffffff).toString(16)}`;
    const frontmatter = [
      "---",
      `id: note-${seed}-${i}`,
      `title: ${JSON.stringify(title)}`,
      tags.length > 0 ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]` : null,
      `created: ${new Date(createdAt).toISOString()}`,
      `updated: ${new Date(updatedAt).toISOString()}`,
      "---",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    const markdown = `${frontmatter}\n\n${bodyMarkdown}\n`;
    notes.push({
      markdown,
      document: {
        pageId,
        vaultId,
        stableNoteId: `note-${seed}-${i}`,
        relativePath: buildRelativePath(archetype, rand, i),
        title,
        tags,
        bodyText: markdownToSearchText(markdown),
        createdAt,
        updatedAt,
        versionToken,
      },
    });
  }
  return notes;
}

/** 仅取 SearchDocument 形态（benchmark 索引链路的直接输入）。 */
export function generateSearchDocuments(
  count: number,
  options: GenerateSearchCorpusOptions = {},
): SearchDocument[] {
  return generateSearchCorpus(count, options).map((note) => note.document);
}
