/**
 * R014：跨库边界链接分类（纯函数）。
 * Inside = 本次迁移集合；Outside = 集合之外（含同库未选中文档）。
 */
export type BoundaryLinkClass =
  | "inside-inside"
  | "outside-inside"
  | "inside-outside";

export function classifyBoundaryLink(input: {
  sourceInSet: boolean;
  targetInSet: boolean;
}): BoundaryLinkClass {
  if (input.sourceInSet && input.targetInSet) return "inside-inside";
  if (!input.sourceInSet && input.targetInSet) return "outside-inside";
  return "inside-outside";
}

export function summarizeBoundary(classes: BoundaryLinkClass[]): {
  internal: number;
  inboundBoundary: number;
  outboundBoundary: number;
} {
  let internal = 0;
  let inboundBoundary = 0;
  let outboundBoundary = 0;
  for (const item of classes) {
    if (item === "inside-inside") internal += 1;
    else if (item === "outside-inside") inboundBoundary += 1;
    else outboundBoundary += 1;
  }
  return { internal, inboundBoundary, outboundBoundary };
}
