/**
 * 持久化级 MarkdownCodec 实现（R005 阶段 4，批次 4A）。
 *
 * 在 src/editor/markdown.ts 的模块级 headless editor（@tiptap/markdown）
 * 之上包一层：Frontmatter 剥离/生成、链接与资源引用收集、不支持语法
 * 检测、换行符策略。不复制的底层解析/序列化逻辑直接复用
 * markdownToJson/jsonToMarkdown——现有导入导出行为与签名不变（兼容约束），
 * 调用方切换（Web 导出集成）属批次 4B。
 *
 * 本批范围：Frontmatter 往返、链接收集、raw HTML / Wiki 链接 / 脚注等
 * 不支持语法检测、serialize 侧节点降级与有损标记。图片/附件二进制写回
 * assets/ 属批次 4B（本批 portable 模式已生成相对引用路径）。
 */
import { sanitizeDocumentContent } from "../../domain/validation/documentContent";
import { jsonToMarkdown, markdownToJson } from "../markdown";
import { generateFrontmatter, splitFrontmatter } from "./frontmatter";
import { collectDocumentLinks } from "./links";
import { transformDocumentForMarkdown } from "./serialize";
import {
  escapeFootnoteRefs,
  maskFencedCode,
  scanFootnotes,
  scanRawHtml,
  scanWikiLinks,
} from "./sourceScan";
import type {
  MarkdownCodec,
  ParsedLink,
  ParsedNote,
  UnsupportedMarkdownFeature,
} from "./types";

/** 检测文档中 src 为 data: 的旧 Base64 图片（parse 侧 unsupported）。 */
function detectDataUriImages(document: unknown): UnsupportedMarkdownFeature[] {
  const out: UnsupportedMarkdownFeature[] = [];
  const walk = (node: {
    type?: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
  }) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "image" &&
      typeof node.attrs?.src === "string" &&
      node.attrs.src.startsWith("data:")
    ) {
      out.push({
        kind: "image-data-uri",
        snippet:
          typeof node.attrs.alt === "string" ? node.attrs.alt : "data: 图片",
        message:
          "Base64 内联图片无法迁移为资源文件；重新序列化时将降级为可见占位文本。",
      });
    }
    for (const child of node.content ?? []) {
      walk(child as typeof node);
    }
  };
  walk(document as Parameters<typeof walk>[0]);
  return out;
}

/** 按 kind+snippet 去重 unsupported 条目（保序）。 */
function dedupeUnsupported(
  entries: UnsupportedMarkdownFeature[],
): UnsupportedMarkdownFeature[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind}${entry.snippet ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 创建 MarkdownCodec 实例。无状态，可直接复用模块级单例
 * （底层转换器本身也是模块级复用的 headless editor）。
 */
export function createMarkdownCodec(): MarkdownCodec {
  return {
    async parse({ markdown, relativePath }) {
      // 换行符策略：检测输入风格，解析前统一归一为 \n
      // （serialize 默认输出 LF，调用方可传 lineEnding 跟随）。
      const lineEnding: ParsedNote["lineEnding"] = markdown.includes("\r\n")
        ? "crlf"
        : "lf";
      const normalized = markdown.replace(/\r\n/g, "\n");

      const { metadata, body } = splitFrontmatter(normalized);

      // 底层解析失败时沿用 markdownToJson 的中文错误（与现状导入一致）。
      // 解析结果再经 domain 白名单复核清洗（双保险：schema 解析本身已过滤）。
      // 脚注先转义再解析：避免 marked 把 `[^1]` 误读为引用式链接（生成
      // href 为脚注文本的伪链接），转义后以纯文本原样保留。
      const parsed = markdownToJson(escapeFootnoteRefs(body));
      const document = sanitizeDocumentContent(parsed);

      // 源文本扫描（先屏蔽围栏代码块防误报）：Wiki 链接 / raw HTML / 脚注。
      const masked = maskFencedCode(body);
      const wikiMatches = scanWikiLinks(masked);
      const wikiLinks: ParsedLink[] = wikiMatches.map((match) => ({
        type: "wiki",
        target: match.target,
        text: match.text,
        anchor: match.anchor,
        // Wiki 目标是页面名而非路径，不做相对路径解析。
      }));

      const { links, assets } = collectDocumentLinks(document, relativePath);

      const unsupported: UnsupportedMarkdownFeature[] = [
        ...wikiMatches.map((match) => ({
          kind: "wiki-link",
          snippet: match.raw,
          message:
            "Wiki 链接已保留为纯文本，未建立页面关联（当前 schema 无对应节点）。",
        })),
        ...scanRawHtml(masked).map((snippet) => ({
          kind: "raw-html",
          snippet,
          message:
            "原始 HTML 未完整保留：可见文本经白名单解析保留，标签与属性已丢弃。",
        })),
        ...scanFootnotes(masked).map((snippet) => ({
          kind: "footnote",
          snippet,
          message: "脚注语法不受支持，已保留为普通文本，未建立脚注关联。",
        })),
        ...detectDataUriImages(document),
      ];

      return {
        document,
        metadata,
        links: [...links, ...wikiLinks],
        assets,
        unsupported: dedupeUnsupported(unsupported),
        lineEnding,
      };
    },

    async serialize({
      document,
      metadata,
      assetResolver,
      mode,
      lineEnding = "lf",
      resolveMentionPath,
    }) {
      const transformed = transformDocumentForMarkdown(document, {
        mode,
        assetResolver,
        resolveMentionPath,
      });
      const body = jsonToMarkdown(transformed.document).trimEnd();

      // Frontmatter 策略：metadata 含任何字段即生成（portable 模式调用方
      // 总是提供 id/title 等；plain 模式默认不传 metadata → 无 Frontmatter，
      // 若调用方显式提供字段则同样写入，两种模式行为一致、以数据为准）。
      const frontmatter = generateFrontmatter(metadata);
      let output = frontmatter ? `${frontmatter}\n\n${body}` : body;

      // 换行符策略：默认 LF；传 "crlf" 跟随 parse 的检测结果。
      if (lineEnding === "crlf") output = output.replace(/\n/g, "\r\n");

      return {
        markdown: output,
        lossy: transformed.unsupported.length > 0,
        unsupported: dedupeUnsupported(transformed.unsupported),
      };
    },
  };
}
