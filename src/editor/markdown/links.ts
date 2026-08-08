/**
 * 链接与资源引用收集（R005 阶段 4，批次 4A）。
 *
 * 解析侧只收集不改写（portable-vault.md：链接重写属导入流程，不在 Codec）：
 * - 标准相对 Markdown 链接 `[标题](../目录/标题.md)` → ParsedLink（markdown）；
 * - 指向非 .md 文件的相对链接 `[name](../assets/design.pdf)` → 附件资源引用；
 * - 相对路径图片 `![alt](../assets/image.png)` → 图片资源引用；
 * - 外部 URL / 绝对路径 / 纯锚点链接不收集（不属于 vault 内引用）。
 * Wiki 链接由 sourceScan.scanWikiLinks 在源文本侧收集，codec 负责合并。
 */
import type { ParsedAssetReference, ParsedLink } from "./types";

/** 外部/非相对目标：带协议（含 mailto:）、`//` 开头、绝对路径或纯锚点。 */
function isExternalTarget(target: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ||
    target.startsWith("//") ||
    target.startsWith("/") ||
    target.startsWith("#")
  );
}

/**
 * 相对路径解析：以笔记在 vault 内的相对路径（relativePath）所在目录
 * 为基准，把链接目标归一到 vault 根（posix 风格）。外部目标返回 undefined。
 */
export function resolveRelativePath(
  relativePath: string | undefined,
  target: string,
): string | undefined {
  if (!relativePath || isExternalTarget(target)) return undefined;
  // 去掉目标中的锚点/查询部分后再做路径归一。
  const pathPart = target.split("#")[0].split("?")[0];
  const segments = relativePath.split("/").slice(0, -1);
  for (const segment of pathPart.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** 目标路径部分是否指向 Markdown 笔记（.md 后缀，大小写不敏感）。 */
function isMarkdownTarget(target: string): boolean {
  const pathPart = target.split("#")[0].split("?")[0];
  return /\.md$/i.test(pathPart);
}

interface WalkNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: WalkNode[];
}

/**
 * 遍历解析后的文档 JSON，收集标准 Markdown 链接与资源引用。
 * @param document 经白名单复核的文档 JSON（parse 结果）。
 * @param relativePath 笔记在 vault 内的相对路径，用于 resolvedPath。
 */
export function collectDocumentLinks(
  document: unknown,
  relativePath?: string,
): { links: ParsedLink[]; assets: ParsedAssetReference[] } {
  const links: ParsedLink[] = [];
  const assets: ParsedAssetReference[] = [];

  const walk = (node: WalkNode | undefined) => {
    if (!node || typeof node !== "object") return;

    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      // data: Base64 图片由 unsupported 检测单列（image-data-uri）；
      // 外部 URL 图片不属于 vault 资源。
      if (!src.startsWith("data:") && !isExternalTarget(src)) {
        assets.push({
          type: "image",
          target: src,
          name: typeof node.attrs.alt === "string" ? node.attrs.alt : undefined,
          resolvedPath: resolveRelativePath(relativePath, src),
        });
      }
    }

    if (node.type === "text" && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark.type !== "link" || typeof mark.attrs?.href !== "string") {
          continue;
        }
        const href = mark.attrs.href;
        if (isExternalTarget(href)) continue;
        if (isMarkdownTarget(href)) {
          links.push({
            type: "markdown",
            target: href,
            text: node.text,
            resolvedPath: resolveRelativePath(relativePath, href),
          });
        } else {
          // 相对路径的非 .md 文件链接：Portable Vault 附件引用形态。
          assets.push({
            type: "attachment",
            target: href,
            name: node.text,
            resolvedPath: resolveRelativePath(relativePath, href),
          });
        }
      }
    }

    for (const child of node.content ?? []) walk(child);
  };
  walk(document as WalkNode);

  return { links, assets };
}
