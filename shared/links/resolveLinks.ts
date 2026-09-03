/**
 * R010 Stage 3（§11）：链接目标解析裁决——把一篇文档的提取链接
 *（ExtractedLink）按当前索引快照解析为落库的 DocumentLink 行。
 *
 * 内存参照实现与 Desktop SQLite 实现共用本函数，契约套件锁定一致：
 * - internal + knownTargetPageId（Editor 节点引用）：按 noteKey 直查；
 * - internal + targetRelativePath（路径链接）：按 vault 根路径查快照；
 * - 解析不到（文件缺失/.. 逃逸）→ broken=true、targetPageId=null
 *  （targetRelativePath 保留，供目标出现时按路径恢复）；
 * - external/mailto/asset/anchor 不参与 broken 裁决（恒 false，
 *   asset 保留归一路径仅供导出/诊断）。
 */
import type { ExtractedLink } from "./extractDocumentLinks.js";
import type { DocumentLink } from "./types.js";

/** 索引快照查询面（实现侧以自身存储满足）。 */
export interface LinkIndexLookup {
  /** 按 vault 根相对路径查文档身份。 */
  byPath(
    relativePath: string,
  ): { noteKey: string; relativePath: string } | null;
  /** 按 noteKey 查（Editor 节点引用的 knownTargetPageId）。 */
  byKey(noteKey: string): { noteKey: string; relativePath: string } | null;
}

/** 解析一篇文档的出站链接（顺序与提取顺序一致）。 */
export function resolveExtractedLinks(
  source: { noteKey: string; versionToken: string },
  links: ExtractedLink[],
  lookup: LinkIndexLookup,
): DocumentLink[] {
  return links.map((link) => {
    const base = {
      sourcePageId: source.noteKey,
      href: link.href,
      label: link.label,
      kind: link.kind,
      fragment: link.fragment,
      sourceVersion: source.versionToken,
    };
    if (link.kind !== "internal") {
      return {
        ...base,
        targetPageId: null,
        targetRelativePath: link.targetRelativePath,
        broken: false,
      };
    }
    // Editor 节点引用（internalLink/mention）：运行时身份直查。
    if (link.knownTargetPageId !== null) {
      const target = lookup.byKey(link.knownTargetPageId);
      return {
        ...base,
        targetPageId: target?.noteKey ?? null,
        targetRelativePath: target?.relativePath ?? link.targetRelativePath,
        broken: target === null,
      };
    }
    // 路径链接：按归一路径查快照（含 .. 逃逸的 null 直接 broken）。
    const target =
      link.targetRelativePath === null
        ? null
        : lookup.byPath(link.targetRelativePath);
    return {
      ...base,
      targetPageId: target?.noteKey ?? null,
      targetRelativePath: link.targetRelativePath,
      broken: target === null,
    };
  });
}
