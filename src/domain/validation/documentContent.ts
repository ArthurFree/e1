/**
 * 文档正文 JSON 的运行时校验与修复（R003 阶段 4）。
 *
 * 背景：IndexedDB 中的 contentJson 历史上只校验 pageId 存在即原样交给
 * Tiptap，损坏数据会让编辑器白屏。本模块提供两个入口：
 * - parseDocumentContent：严格校验，损坏时返回带 CORRUPTED_DOCUMENT
 *   错误码的结果，调用方据此展示「文档内容损坏」UI；
 * - sanitizeDocumentContent：尽力修复——剔除非法节点/标记、保留合法子树，
 *   供「尝试恢复」使用；返回值恒为合法 doc（最差为空文档）。
 *
 * 白名单（ALLOWED_NODE_TYPES / ALLOWED_MARK_TYPES）必须与
 * src/editor/extensions.ts 的 buildDocumentExtensions 保持同步；
 * 同步关系由 documentContent.test.ts 用真实 schema 强制校验。
 */
import { DomainError } from "../errors";

/** 校验后的 Tiptap 节点（结构最小集，不约束各节点 attrs 的具体形状）。 */
export interface TiptapNode {
  type: string;
  content?: TiptapNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface TiptapDoc {
  type: "doc";
  content?: TiptapNode[];
}

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: DomainError; raw: unknown };

/**
 * 节点类型白名单：buildDocumentExtensions 注册的全部节点
 * （含 mention / inlineMath / blockMath / attachment / localImage）。
 */
export const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph",
  "text",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "image",
  "localImage",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "mention",
  "inlineMath",
  "blockMath",
  "attachment",
]);

/** 标记类型白名单：StarterKit + Highlight + TextStyleKit + 上下标。 */
export const ALLOWED_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "highlight",
  "subscript",
  "superscript",
  "textStyle",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 需要校验关键 attrs 的节点：字段缺失/类型错误即视为损坏
 * （这些节点失去关键字段后无法正确渲染，sanitize 时整体丢弃）。
 */
const REQUIRED_ATTR_TYPES: Record<string, { attr: string; type: string }> = {
  attachment: { attr: "attachmentId", type: "string" },
  localImage: { attr: "attachmentId", type: "string" },
  mention: { attr: "id", type: "string" },
  image: { attr: "src", type: "string" },
};

/** 深度优先校验节点；返回第一个损坏原因，null 表示合法。 */
function findNodeError(node: unknown, path: string): string | null {
  if (!isPlainObject(node)) return `${path} 不是对象`;
  if (typeof node.type !== "string") return `${path} 缺少 type`;
  if (!ALLOWED_NODE_TYPES.has(node.type))
    return `${path} 类型非法: ${node.type}`;
  if (node.type === "doc") return `${path} 不允许嵌套 doc`;

  if ("text" in node) {
    if (node.type !== "text") return `${path} 非文本节点不允许 text 字段`;
    if (typeof node.text !== "string") return `${path} text 必须是字符串`;
  }
  if (node.type === "text" && typeof node.text !== "string") {
    return `${path} 文本节点缺少 text`;
  }

  if ("attrs" in node && node.attrs !== undefined) {
    if (!isPlainObject(node.attrs)) return `${path} attrs 必须是对象`;
    const required = REQUIRED_ATTR_TYPES[node.type];
    if (required && typeof node.attrs[required.attr] !== required.type) {
      return `${path} attrs.${required.attr} 类型错误`;
    }
  }
  if (node.type in REQUIRED_ATTR_TYPES && !isPlainObject(node.attrs)) {
    return `${path} 缺少 attrs`;
  }

  if ("marks" in node && node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return `${path} marks 必须是数组`;
    for (let i = 0; i < node.marks.length; i++) {
      const mark: unknown = node.marks[i];
      if (!isPlainObject(mark) || typeof mark.type !== "string") {
        return `${path}.marks[${i}] 缺少 type`;
      }
      if (!ALLOWED_MARK_TYPES.has(mark.type)) {
        return `${path}.marks[${i}] 标记非法: ${mark.type}`;
      }
      if (
        "attrs" in mark &&
        mark.attrs !== undefined &&
        !isPlainObject(mark.attrs)
      ) {
        return `${path}.marks[${i}] attrs 必须是对象`;
      }
    }
  }

  if ("content" in node && node.content !== undefined) {
    if (!Array.isArray(node.content)) return `${path} content 必须是数组`;
    for (let i = 0; i < node.content.length; i++) {
      const err = findNodeError(node.content[i], `${path}.content[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/**
 * 严格校验正文 JSON。损坏时返回 CORRUPTED_DOCUMENT 错误与原始数据，
 * 调用方不得把 raw 直接交给编辑器。
 */
export function parseDocumentContent(raw: unknown): ParseResult<TiptapDoc> {
  if (!isPlainObject(raw) || raw.type !== "doc") {
    return {
      ok: false,
      error: new DomainError(
        "CORRUPTED_DOCUMENT",
        "文档内容损坏：根节点不是 doc",
      ),
      raw,
    };
  }
  if (
    "content" in raw &&
    raw.content !== undefined &&
    !Array.isArray(raw.content)
  ) {
    return {
      ok: false,
      error: new DomainError(
        "CORRUPTED_DOCUMENT",
        "文档内容损坏：content 不是数组",
      ),
      raw,
    };
  }
  const content = (raw.content as unknown[] | undefined) ?? [];
  for (let i = 0; i < content.length; i++) {
    const err = findNodeError(content[i], `content[${i}]`);
    if (err) {
      return {
        ok: false,
        error: new DomainError("CORRUPTED_DOCUMENT", `文档内容损坏：${err}`),
        raw,
      };
    }
  }
  return { ok: true, value: raw as unknown as TiptapDoc };
}

/** 修复单个节点；返回 null 表示无法保留（调用方丢弃或提升其子内容）。 */
function sanitizeNode(node: unknown): TiptapNode | TiptapNode[] | null {
  if (!isPlainObject(node) || typeof node.type !== "string") return null;

  // 未知类型：尝试提升其合法子内容（保住文字），否则丢弃。
  if (!ALLOWED_NODE_TYPES.has(node.type) || node.type === "doc") {
    if (Array.isArray(node.content)) return sanitizeChildren(node.content);
    return null;
  }

  const out: TiptapNode = { type: node.type };

  if (node.type === "text") {
    if (typeof node.text !== "string") return null;
    out.text = node.text;
  }

  if (isPlainObject(node.attrs)) {
    const required = REQUIRED_ATTR_TYPES[node.type];
    // 关键字段损坏的节点无法正确渲染，整体丢弃（子内容由上层提升逻辑处理）。
    if (required && typeof node.attrs[required.attr] !== required.type) {
      return Array.isArray(node.content)
        ? sanitizeChildren(node.content)
        : null;
    }
    out.attrs = { ...node.attrs };
  } else if (node.type in REQUIRED_ATTR_TYPES) {
    return Array.isArray(node.content) ? sanitizeChildren(node.content) : null;
  }

  if (Array.isArray(node.marks)) {
    const marks = node.marks.filter(
      (m): m is { type: string; attrs?: Record<string, unknown> } =>
        isPlainObject(m) &&
        typeof m.type === "string" &&
        ALLOWED_MARK_TYPES.has(m.type) &&
        (!("attrs" in m) || m.attrs === undefined || isPlainObject(m.attrs)),
    );
    if (marks.length > 0) out.marks = marks;
  }

  if (Array.isArray(node.content)) {
    out.content = sanitizeChildren(node.content);
  }
  return out;
}

function sanitizeChildren(children: unknown[]): TiptapNode[] {
  const out: TiptapNode[] = [];
  for (const child of children) {
    const result = sanitizeNode(child);
    if (result === null) continue;
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return out;
}

/**
 * 尽力修复损坏的正文 JSON：剔除非法节点与标记、提升可保留的子内容，
 * 返回恒为合法的 doc（无法保留任何内容时为空文档）。
 */
export function sanitizeDocumentContent(raw: unknown): TiptapDoc {
  if (!isPlainObject(raw) || !Array.isArray(raw.content)) {
    return { type: "doc", content: [] };
  }
  return { type: "doc", content: sanitizeChildren(raw.content) };
}
