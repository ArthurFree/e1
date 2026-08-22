// R008 Stage 3（§10.7）：搜索 benchmark fixture 生成器——确定性
//（种子固定）生成一个 Markdown Vault 目录，覆盖分布：中文标题、英文
// 标题、中英混合、多标签、长文、短文、深目录、重复词、高频词、emoji、
// code block、links、tables、frontmatter。
//
// 用法：
//   node fixtures/search/generator.mjs <目标目录> <数量> [种子]
//
// 1k / 10k / 50k 均按需生成（产物目录不提交，见 .gitignore）；
// 供 perf 基准（src/**/*perf-wallclock.test.ts）与 Stage 4/6 批量索引
// 验收共用。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** mulberry32 确定性伪随机（种子固定 → 同数量同内容）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH_TITLE = [
  "组件化设计",
  "响应式原理",
  "状态管理",
  "前端工程化",
  "算法笔记",
  "读书笔记",
  "会议纪要",
  "周报汇总",
  "知识图谱",
  "全文搜索",
];
const EN_TITLE = [
  "React Hooks",
  "Rust Ownership",
  "SQLite FTS",
  "Indexing Strategy",
  "Design Notes",
  "Weekly Review",
  "API Design",
  "Performance Tuning",
];
const TAGS = [
  "前端",
  "后端",
  "算法",
  "读书",
  "工作",
  "随想",
  "search",
  "notes",
];
const ZH_SENT = [
  "今天研究了中文分词的实现方案，bigram 覆盖是一个可控的选择。",
  "组件化的核心在于边界清晰与状态最小化，避免隐式共享。",
  "索引只是派生数据，真正的正文永远是磁盘上的 Markdown 文件。",
  "高频词高频词高频词，重复出现的词汇对排序没有额外帮助。",
  "深目录结构在大型知识库中非常常见，路径只是位置不是身份。",
];
const EN_SENT = [
  "Ownership and borrowing keep memory safe without a garbage collector.",
  "The search index is derived data and can always be rebuilt from source.",
  "Prefix matching works well for latin words but not for CJK substrings.",
  "Benchmark fixtures must be deterministic so results stay comparable.",
];
const EMOJI = ["🎉", "🚀", "✨", "📚", "🔥"];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/** 生成第 i 篇笔记的相对路径与 Markdown 内容。 */
export function generateNote(i, random) {
  const kind = i % 10;
  const n = Math.floor(i / 10) + 1;
  let title;
  if (kind < 4) title = `${pick(random, ZH_TITLE)} ${n}`;
  else if (kind < 7) title = `${pick(random, EN_TITLE)} ${n}`;
  else title = `${pick(random, ZH_TITLE)} ${pick(random, EN_TITLE)} ${n}`;

  const tagCount = i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1;
  const tags = [];
  for (let t = 0; t < tagCount; t += 1) tags.push(pick(random, TAGS));

  const long = i % 20 === 0;
  const paragraphs = [];
  const paraCount = long ? 60 : 2 + (i % 3);
  for (let p = 0; p < paraCount; p += 1) {
    const zh = random() < 0.6;
    paragraphs.push(zh ? pick(random, ZH_SENT) : pick(random, EN_SENT));
  }
  if (i % 15 === 0) paragraphs.push(`常用表情：${EMOJI.join(" ")}`);
  if (i % 12 === 0) {
    paragraphs.push(
      "```ts\nfunction tokenizeForIndex(text: string): Set<string> {\n  return new Set(text.split(/\\s+/));\n}\n```",
    );
  }
  if (i % 11 === 0) {
    paragraphs.push("参考 [Tiptap 文档](https://tiptap.dev) 与 [[内部链接]]。");
  }
  if (i % 9 === 0) {
    paragraphs.push(
      "| 名称 | 价格 | 数量 |\n| --- | --- | --- |\n| 苹果 | 3.5 | 十斤 |",
    );
  }

  const id = `01BENCH${String(i).padStart(16, "0")}`;
  const tagsYaml = tags.length
    ? `tags: [${tags.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(", ")}]\n`
    : "";
  const markdown = `---\nid: ${id}\ntitle: ${title}\n${tagsYaml}---\n\n# ${title}\n\n${paragraphs.join("\n\n")}\n`;

  // 每 50 篇进一层深目录（最深 8 层）；文件名冲突按序号递增。
  const depth = Math.floor(i / 50) % 8;
  const dir = depth > 0 ? `${"层/".repeat(depth)}层` : "";
  const relativePath = `${dir ? `${dir}/` : ""}${title.replace(/[\\/:*?"<>|]/g, "-")}.md`;
  return { relativePath, markdown };
}

/** 生成 count 篇笔记到目标目录（返回相对路径列表）。 */
export async function generateVault(targetDir, count, seed = 20260822) {
  const random = rng(seed);
  const paths = [];
  for (let i = 0; i < count; i += 1) {
    const { relativePath, markdown } = generateNote(i, random);
    const abs = join(targetDir, ...relativePath.split("/"));
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, markdown, "utf8");
    paths.push(relativePath);
  }
  return paths;
}

// CLI：node fixtures/search/generator.mjs <dir> <count> [seed]
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [dir, countArg, seedArg] = process.argv.slice(2);
  if (!dir || !countArg) {
    console.error(
      "用法：node fixtures/search/generator.mjs <目标目录> <数量> [种子]",
    );
    process.exit(1);
  }
  const paths = await generateVault(
    dir,
    Number(countArg),
    seedArg ? Number(seedArg) : undefined,
  );
  console.log(`已生成 ${paths.length} 篇笔记到 ${dir}`);
}
