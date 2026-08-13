/**
 * R006-C5-E：把 Markdown 相对资源引用恢复为 localImage / attachment。
 *
 * 仅 managed assetsDirectory 下的路径升级；HTTP(S) 图、Vault 外路径、
 * 内嵌文件链接保持原节点。缺失文件仍升级并登记，UI 显示不可用。
 */
import { encodeDesktopAssetId } from "../../../shared/assets/desktopAssetId";
import { resolveRelativePath } from "../../editor/markdown/links";
import type { ParsedAssetReference } from "../../editor/markdown/types";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";

export interface HydrateAssetsInput {
  vaultId: string;
  pageId: string;
  noteRelativePath: string;
  document: unknown;
  assets: ParsedAssetReference[];
  assetsDirectory: string | null;
  registry: DesktopAssetRegistry;
}

export interface HydrateAssetsResult {
  document: unknown;
}

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: JsonMark[];
  content?: JsonNode[];
}

function isManagedPath(
  resolvedPath: string | undefined,
  assetsDirectory: string | null,
): resolvedPath is string {
  if (!resolvedPath || !assetsDirectory) return false;
  const prefix = assetsDirectory.replace(/\/+$/, "");
  return resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`);
}

function inferMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function register(
  input: HydrateAssetsInput,
  relativePath: string,
  name: string,
  mimeType: string,
): string {
  const existing = input.registry.findByPath(input.vaultId, relativePath);
  if (existing) {
    if (!existing.pageId) {
      input.registry.register({ ...existing, pageId: input.pageId });
    }
    return existing.id;
  }
  const id = encodeDesktopAssetId(input.vaultId, relativePath);
  input.registry.register({
    id,
    vaultId: input.vaultId,
    relativePath,
    name,
    mimeType,
    size: 0,
    pageId: input.pageId,
  });
  return id;
}

function soleFileLink(node: JsonNode): { href: string; text: string } | null {
  if (node.type !== "paragraph" || node.content?.length !== 1) return null;
  const child = node.content[0];
  if (child.type !== "text" || !Array.isArray(child.marks)) return null;
  const linkMarks = child.marks.filter((mark) => mark.type === "link");
  if (linkMarks.length !== 1 || child.marks.length !== 1) return null;
  const href = linkMarks[0].attrs?.href;
  if (typeof href !== "string") return null;
  return { href, text: child.text ?? "" };
}

function isMarkdownHref(href: string): boolean {
  return /\.md$/i.test(href.split("#")[0].split("?")[0]);
}

export function hydrateDesktopMarkdownAssets(
  input: HydrateAssetsInput,
): HydrateAssetsResult {
  const walk = (node: JsonNode | undefined): JsonNode | undefined => {
    if (!node || typeof node !== "object") return node;

    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      const resolved =
        resolveRelativePath(input.noteRelativePath, src) ??
        input.assets.find((a) => a.type === "image" && a.target === src)
          ?.resolvedPath;
      if (isManagedPath(resolved, input.assetsDirectory)) {
        const alt =
          typeof node.attrs.alt === "string" && node.attrs.alt
            ? node.attrs.alt
            : resolved.split("/").pop() ?? "image";
        const attachmentId = register(
          input,
          resolved,
          alt,
          inferMime(resolved),
        );
        return {
          type: "localImage",
          attrs: { attachmentId, alt, width: null },
        };
      }
      return node;
    }

    const sole = soleFileLink(node);
    if (sole && !isMarkdownHref(sole.href)) {
      const resolved =
        resolveRelativePath(input.noteRelativePath, sole.href) ??
        input.assets.find(
          (a) => a.type === "attachment" && a.target === sole.href,
        )?.resolvedPath;
      if (isManagedPath(resolved, input.assetsDirectory)) {
        const name = sole.text || resolved.split("/").pop() || "附件";
        const attachmentId = register(
          input,
          resolved,
          name,
          inferMime(resolved),
        );
        return {
          type: "attachment",
          attrs: {
            attachmentId,
            name,
            mimeType: inferMime(resolved),
            size: 0,
          },
        };
      }
    }

    if (Array.isArray(node.content)) {
      return {
        ...node,
        content: node.content.map((child) => walk(child) ?? child),
      };
    }
    return node;
  };

  return { document: walk(input.document as JsonNode) ?? input.document };
}
