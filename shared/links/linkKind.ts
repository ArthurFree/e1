/**
 * R010 Stage 0：链接语义冻结——链接分类、fragment 剥离、相对路径归一。
 *
 * 环境中立、零依赖：Renderer（保存侧 JSON 提取）与 Electron Main
 * （索引侧 Markdown 提取）共用同一语义核心，契约测试锁定一致。
 *
 * 冻结规则（R010 §Stage 0 / LINK-01/02/04）：
 * - 磁盘链接是普通 Markdown 相对路径，不引入私有协议；
 * - 分类只看 href 形态：internal（相对 .md）/ external（协议、//、绝对路径）/
 *   mailto / asset（相对非 .md）/ anchor（纯 #片段）；
 * - 路径归一前先做百分号解码（中文路径、空格 %20），解码失败回退原文；
 * - 归一结果越过 vault 根（.. 逃逸）→ 返回 null，由索引层按 broken 处理；
 * - 不按 title 定位，身份解析（path → stable page id）在索引层完成。
 */

export type LinkKind = "internal" | "external" | "mailto" | "asset" | "anchor";

/** 链接分类结果：保留原始 href，另给出剥离 fragment/query 的路径与 fragment。 */
export interface ClassifiedLink {
  kind: LinkKind;
  /** 原始 href（不改写，LINK-01：磁盘原文即真相）。 */
  href: string;
  /** 剥离 fragment/query 后的路径部分（未解码）。 */
  path: string;
  /** `#anchor` 部分（不含 `#`），无则 null。 */
  fragment: string | null;
}

/** 剥离 fragment（#…）与查询（?…）：fragment 取 `#` 后到 `?` 前的内容。 */
export function splitHref(href: string): {
  path: string;
  fragment: string | null;
} {
  const hashIndex = href.indexOf("#");
  const withFragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : null;
  const pathPart = (hashIndex >= 0 ? href.slice(0, hashIndex) : href).split(
    "?",
  )[0]!;
  let fragment: string | null = null;
  if (withFragment !== null) {
    const queryIndex = withFragment.indexOf("?");
    fragment =
      queryIndex >= 0 ? withFragment.slice(0, queryIndex) : withFragment;
  }
  return { path: pathPart, fragment };
}

/** 百分号解码（中文路径、%20 空格）；非法编码回退原文。 */
export function decodeLinkPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 链接分类：只看 href 形态，不做存在性判断（broken 由索引层裁决）。 */
export function classifyLinkHref(href: string): ClassifiedLink {
  const { path, fragment } = splitHref(href);
  if (href.startsWith("#")) {
    return { kind: "anchor", href, path: "", fragment };
  }
  if (/^mailto:/i.test(href)) {
    return { kind: "mailto", href, path, fragment };
  }
  if (SCHEME.test(href) || href.startsWith("//") || href.startsWith("/")) {
    return { kind: "external", href, path, fragment };
  }
  const decoded = decodeLinkPath(path);
  const kind: LinkKind = /\.md$/i.test(decoded) ? "internal" : "asset";
  return { kind, href, path, fragment };
}

/**
 * 相对路径归一：以来源笔记在 vault 内的相对路径所在目录为基准，
 * 把链接目标归一到 vault 根（posix 风格，已解码）。
 *
 * 仅对相对目标（internal/asset）有意义；外部目标或 .. 越过 vault 根
 * 时返回 null（索引层据此标记 broken，而非静默夹取到根目录）。
 */
export function resolveLinkPath(
  fromRelativePath: string,
  href: string,
): string | null {
  const classified = classifyLinkHref(href);
  if (classified.kind !== "internal" && classified.kind !== "asset") {
    return null;
  }
  const decoded = decodeLinkPath(classified.path);
  const segments = fromRelativePath.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("/") : null;
}
