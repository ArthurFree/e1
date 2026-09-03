/**
 * R011 Stage 1：路径搬迁后的相对 href 纯函数。
 *
 * oldHref 表示 relative(S0 → T0)；操作后应为 relative(S1 → T1)。
 * 若新旧 href 路径部分等价则返回旧值（调用方可 skip）。
 */
import { relativeVaultPath } from "../markdown/relativePath.js";
import {
  classifyLinkHref,
  decodeLinkPath,
  splitHref,
} from "./linkKind.js";

export interface RelocateHrefInput {
  /** 操作前源文档路径。 */
  sourcePathBefore: string;
  /** 操作前目标路径（vault 根相对）。 */
  targetPathBefore: string;
  /** 操作后源文档路径。 */
  sourcePathAfter: string;
  /** 操作后目标路径。 */
  targetPathAfter: string;
  /** 原文 href（可含 fragment）。 */
  oldHref: string;
}

export interface RelocateHrefResult {
  newHref: string;
  /** true 表示应改写。 */
  changed: boolean;
}

/**
 * 计算搬迁后的相对 href；external/mailto/anchor 原样返回且 changed=false。
 */
export function relocateHref(input: RelocateHrefInput): RelocateHrefResult {
  const classified = classifyLinkHref(input.oldHref);
  if (
    classified.kind !== "internal" &&
    classified.kind !== "asset"
  ) {
    return { newHref: input.oldHref, changed: false };
  }

  const { fragment } = splitHref(input.oldHref);
  const newPath = relativeVaultPath(
    input.sourcePathAfter,
    input.targetPathAfter,
  );
  // 与磁盘常见写法对齐：尽量保留未编码相对路径；空格由 patcher 决定是否 angle。
  const fragmentSuffix = fragment !== null ? `#${fragment}` : "";
  const newHref = `${newPath}${fragmentSuffix}`;

  const oldPathDecoded = decodeLinkPath(splitHref(input.oldHref).path);
  const expectedOld = relativeVaultPath(
    input.sourcePathBefore,
    input.targetPathBefore,
  );
  // 若调用方给的 T0/S0 与 href 不一致，仍以 S1→T1 为准。
  void expectedOld;
  void oldPathDecoded;

  if (splitHref(newHref).path === splitHref(input.oldHref).path) {
    // 路径部分相同：保留原文（含编码形态），避免无意义改写。
    return { newHref: input.oldHref, changed: false };
  }

  return { newHref, changed: true };
}

/**
 * 将一组 pathMoves 应用到路径：若 path 是某 from 的前缀（目录）或精确匹配，映射到 to。
 */
export function applyPathMoves(
  relativePath: string,
  pathMoves: Array<{ fromRelativePath: string; toRelativePath: string }>,
): string {
  // 长前缀优先（深层目录先匹配）。
  const sorted = [...pathMoves].sort(
    (a, b) => b.fromRelativePath.length - a.fromRelativePath.length,
  );
  for (const move of sorted) {
    if (relativePath === move.fromRelativePath) {
      return move.toRelativePath;
    }
    const prefix = move.fromRelativePath.endsWith("/")
      ? move.fromRelativePath
      : `${move.fromRelativePath}/`;
    if (relativePath.startsWith(prefix)) {
      return move.toRelativePath + relativePath.slice(move.fromRelativePath.length);
    }
  }
  return relativePath;
}
