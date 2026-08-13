/**
 * Frontmatter 解析与生成（R005 阶段 4 批次 4A 初建；R006 阶段 2 自
 * src/editor/markdown/frontmatter.ts 平移至 shared/）。
 *
 * 移动原因（R006 阶段 2）：Electron Main 扫描 Vault 时需要与 Renderer 侧
 * MarkdownCodec 完全一致的 Frontmatter 解析行为，而 electron 不得 import
 * src（分层约束）——本模块为零依赖纯字符串处理（不触 Node/DOM API），
 * 满足 shared/ 环境中立要求，故整体平移；src 侧经
 * src/editor/markdown/frontmatter.ts 与 types.ts re-export 保持既有
 * import 路径不变，codec 行为由同一实现保证一致（既有测试套件不变全绿）。
 *
 * package.json 无 YAML 依赖且本批不新增依赖，因此手写最小 YAML 子集：
 * - 支持 `key: value` 标量、流式列表 `tags: [a, b]`、块式列表（`- item` 续行）；
 * - 不支持嵌套对象、锚点、多行字符串等高级特性；
 * - **未知字段不解析、不丢弃、不重排**：整段原始行（含续行）存入
 *   FrontmatterExtraField.rawLines，serialize 时逐行原样写回；
 * - Frontmatter 块内的空行与注释行不保留（未知字段本身完整保留即可，
 *   见 FrontmatterExtraField 字段语义）。
 *
 * 已知字段集（portable-vault.md identityMode: frontmatter + aliases 扩展）：
 * id / title / tags / created / updated / aliases。
 */

/** Frontmatter 中无法识别（未纳入已知字段集）的字段，原始行保序保留。 */
export interface FrontmatterExtraField {
  /** 字段名（YAML key），仅诊断用途；写回以 rawLines 为准。 */
  key: string;
  /**
   * 该字段在原文中的完整行（含 `key: value` 行与续行，如块式列表项），
   * serialize 时逐行原样写回——不解析、不重排、不丢弃。
   */
  rawLines: string[];
}

/**
 * 笔记的可移植元数据：Portable Vault Frontmatter 的内存形态
 * （portable-vault.md：id/title/tags/created/updated，aliases 为通用扩展）。
 * 时间字段为 ISO 字符串。
 */
export interface PortableNoteMetadata {
  id?: string;
  title?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  aliases?: string[];
  /** 解析侧保留的未知 Frontmatter 字段；serialize 原样写回。 */
  extra?: FrontmatterExtraField[];
}

/** splitFrontmatter 的解析结果：typed 元数据 + 剥离 Frontmatter 后的正文。 */
export interface FrontmatterSplit {
  metadata: {
    id?: string;
    title?: string;
    tags: string[];
    createdAt?: string;
    updatedAt?: string;
    aliases: string[];
    extra: FrontmatterExtraField[];
  };
  /** 剥离 Frontmatter 后的正文（已去掉 Frontmatter 块与其后的空行）。 */
  body: string;
  hasFrontmatter: boolean;
}

/** 已知字段 key → metadata 字段名的映射（created/updated → createdAt/updatedAt）。 */
const KNOWN_KEYS = new Set([
  "id",
  "title",
  "tags",
  "created",
  "updated",
  "aliases",
]);

/** 列表字段（tags / aliases），其余已知字段为标量。 */
const LIST_KEYS = new Set(["tags", "aliases"]);

/** 条目起始行：`key: value` 或 `key:`。key 限定为安全字符集。 */
const KEY_LINE = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
/** 块式列表续行：`  - item`（允许任意前导空白）。 */
const BLOCK_LIST_ITEM = /^\s+-\s+(.*)$/;
/** 顶层块式列表续行：`- item`（无前导空白，YAML 允许）。 */
const TOP_LEVEL_LIST_ITEM = /^-\s+(.*)$/;

/** 去除标量两侧引号并反转义（双引号处理 \" \\，单引号处理 ''）。 */
function unquoteScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\])/g, "$1")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** 解析流式列表 `[a, b, "c"]`；非流式语法返回 null。 */
function parseFlowList(raw: string): string[] | null {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  // 最小子集：按逗号切分后逐项去引号；引号内含逗号的条目不支持
  // （生成侧会给含逗号的值加引号，重新导入时按整项保留即可，见测试）。
  return splitFlowItems(inner).map((item) => unquoteScalar(item));
}

/** 流式列表切分：跳过双/单引号内的逗号。 */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") items.push(current);
  return items.map((item) => item.trim());
}

/** Frontmatter 内的一个条目：key 行 + 后续续行（列表项或无法识别的内容）。 */
interface RawEntry {
  key: string;
  /** key 行中 `:` 之后的原始值文本（无值时为 undefined）。 */
  valueRaw?: string;
  /** 续行原文（块式列表项、嵌套内容等），保持顺序。 */
  continuationLines: string[];
  /** key 行原文（未知字段写回用）。 */
  firstLine: string;
}

/** 把 Frontmatter 块内文本按条目分组（忽略空行与整行注释）。 */
function groupEntries(block: string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = line.match(KEY_LINE);
    // 续行（前导空白开头）不视为新条目，即使形如 `key: value`。
    if (match && !/^\s/.test(line)) {
      entries.push({
        key: match[1],
        valueRaw: match[2],
        continuationLines: [],
        firstLine: line,
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].continuationLines.push(line);
    }
    // 块内不属于任何条目的行（如首部注释已在上面跳过）直接忽略。
  }
  return entries;
}

/** 从条目解析 typed 值（标量或列表），尽力而为、失败回退 undefined/[]。 */
function parseEntryValue(entry: RawEntry): string | string[] | undefined {
  if (LIST_KEYS.has(entry.key)) {
    if (entry.valueRaw !== undefined) {
      const flow = parseFlowList(entry.valueRaw);
      if (flow) return flow;
      const scalar = unquoteScalar(entry.valueRaw);
      return scalar === "" ? [] : [scalar];
    }
    // 块式列表：续行中的 `- item`。
    const items: string[] = [];
    for (const line of entry.continuationLines) {
      const item =
        line.match(BLOCK_LIST_ITEM)?.[1] ??
        line.match(TOP_LEVEL_LIST_ITEM)?.[1];
      if (item !== undefined) items.push(unquoteScalar(item));
    }
    return items;
  }
  if (entry.valueRaw !== undefined) return unquoteScalar(entry.valueRaw);
  return undefined;
}

/**
 * 剥离并解析 Frontmatter。markdown 须已把换行归一为 `\n`（codec 负责）。
 * 仅当首行整行为 `---` 且存在闭合 `---` 行时视为 Frontmatter，
 * 否则原样返回（避免与文档开头的 horizontalRule 混淆）。
 */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const empty = {
    metadata: { tags: [], aliases: [], extra: [] },
    body: markdown,
    hasFrontmatter: false,
  } satisfies FrontmatterSplit;
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return empty;
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return empty;

  const metadata: FrontmatterSplit["metadata"] = {
    tags: [],
    aliases: [],
    extra: [],
  };
  for (const entry of groupEntries(lines.slice(1, closeIndex).join("\n"))) {
    if (!KNOWN_KEYS.has(entry.key)) {
      // 未知字段：原始行整段保留（key 行 + 续行），写回时不重排。
      metadata.extra.push({
        key: entry.key,
        rawLines: [entry.firstLine, ...entry.continuationLines],
      });
      continue;
    }
    const value = parseEntryValue(entry);
    switch (entry.key) {
      case "id":
        if (typeof value === "string") metadata.id = value;
        break;
      case "title":
        if (typeof value === "string") metadata.title = value;
        break;
      case "created":
        if (typeof value === "string") metadata.createdAt = value;
        break;
      case "updated":
        if (typeof value === "string") metadata.updatedAt = value;
        break;
      case "tags":
        if (Array.isArray(value)) metadata.tags = value;
        break;
      case "aliases":
        if (Array.isArray(value)) metadata.aliases = value;
        break;
    }
  }

  // 闭合行之后最多跳过一个空行，其余原样作为正文。
  let bodyStart = closeIndex + 1;
  if (lines[bodyStart]?.trim() === "") bodyStart += 1;
  return {
    metadata,
    body: lines.slice(bodyStart).join("\n"),
    hasFrontmatter: true,
  };
}

/** 标量写出时是否需要加引号（最小 YAML 规则）。 */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  // 首字符为 YAML 指示符，或含有会破坏最小解析的 `: ` / ` #` 序列。
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/:\s|\s#/.test(value)) return true;
  // 流式集合指示符：在 flow list `[a, b]` 内会破坏条目切分。
  if (/[[\]{},]/.test(value)) return true;
  // 会被 YAML 误读为布尔/空值的标量。
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  // 整体为数字的标量（ISO 时间含 `-`/`:`/`+`，不是纯数字，不受影响）。
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(value)) return true;
  return false;
}

/** 标量写出：必要时双引号包裹并转义。 */
function formatScalar(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 列表字段统一写成流式：`tags: [a, "b"]`。 */
function formatFlowList(key: string, items: string[]): string {
  return `${key}: [${items.map(formatScalar).join(", ")}]`;
}

/**
 * 生成 Frontmatter 块（含起止 `---` 行；尾部不带换行，由调用方拼接）。
 * 字段顺序固定为 id/title/tags/created/updated/aliases，未知字段
 * （extra）按解析时的原始顺序附在最后，rawLines 逐行原样写回。
 * 无任何字段可写时返回空串（调用方据此省略整块 Frontmatter）。
 */
export function generateFrontmatter(metadata: PortableNoteMetadata): string {
  const lines: string[] = [];
  if (metadata.id !== undefined) lines.push(`id: ${formatScalar(metadata.id)}`);
  if (metadata.title !== undefined) {
    lines.push(`title: ${formatScalar(metadata.title)}`);
  }
  if (metadata.tags !== undefined && metadata.tags.length > 0) {
    lines.push(formatFlowList("tags", metadata.tags));
  }
  if (metadata.createdAt !== undefined) {
    lines.push(`created: ${formatScalar(metadata.createdAt)}`);
  }
  if (metadata.updatedAt !== undefined) {
    lines.push(`updated: ${formatScalar(metadata.updatedAt)}`);
  }
  if (metadata.aliases !== undefined && metadata.aliases.length > 0) {
    lines.push(formatFlowList("aliases", metadata.aliases));
  }
  for (const field of metadata.extra ?? []) lines.push(...field.rawLines);
  if (lines.length === 0) return "";
  return ["---", ...lines, "---"].join("\n");
}

/**
 * R006-C4.1-D（FR-22/23/24）：保证 Markdown 含 Frontmatter `id`。
 *
 * - 已有 id → 沿用，不改写正文；
 * - 无 id / 无 Frontmatter → 注入 generatedId，保留 title/tags/aliases/
 *   created/updated/未知字段与正文。
 * Main 只依赖本纯函数，不得 import Tiptap / MarkdownCodec。
 */
export function ensureFrontmatterId(
  markdown: string,
  generatedId: string,
): { markdown: string; noteId: string } {
  const crlf = markdown.includes("\r\n");
  const normalized = markdown.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(normalized);
  if (typeof split.metadata.id === "string" && split.metadata.id.length > 0) {
    return { markdown, noteId: split.metadata.id };
  }
  const fm = generateFrontmatter({
    id: generatedId,
    title: split.metadata.title,
    tags: split.metadata.tags.length > 0 ? split.metadata.tags : undefined,
    createdAt: split.metadata.createdAt,
    updatedAt: split.metadata.updatedAt,
    aliases:
      split.metadata.aliases.length > 0 ? split.metadata.aliases : undefined,
    extra: split.metadata.extra,
  });
  const next =
    split.body.length > 0 ? `${fm}\n\n${split.body}` : `${fm}\n\n`;
  return {
    markdown: crlf ? next.replace(/\n/g, "\r\n") : next,
    noteId: generatedId,
  };
}
