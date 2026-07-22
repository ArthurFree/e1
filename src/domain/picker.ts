/**
 * 创建位置选择纯逻辑（R001）：新建文档/分组时，构造
 * 「知识库根目录 + 其下全部分组」的可选目标列表，供 TargetPicker 展示。
 * 文档不能作为父级，因此只有分组参与遍历。
 */

import type { Page, Workspace } from "./types";
import { childrenOf } from "./pageTree";

/** 创建位置选择条目：一个知识库根或其下的一个分组。 */
export interface PickerTarget {
  workspaceId: string;
  workspaceName: string;
  /** 目标父级：null 表示直接建在知识库根下。 */
  parentId: string | null;
  /** 展示文案：知识库条目带图标前缀，分组为标题。 */
  label: string;
  /** 缩进层级：知识库为 0，其下分组从 1 起递增。 */
  depth: number;
}

/** 创建位置选择条目：知识库根目录 + 其下全部分组（按树序、缩进深度）。 */
export function buildPickerTargets(
  workspaces: Pick<Workspace, "id" | "name" | "icon">[],
  pages: Page[],
): PickerTarget[] {
  const targets: PickerTarget[] = [];
  for (const ws of workspaces) {
    targets.push({
      workspaceId: ws.id,
      workspaceName: ws.name,
      parentId: null,
      label: `${ws.icon ?? "📚"} ${ws.name}`,
      depth: 0,
    });
    const walk = (parentId: string | null, depth: number) => {
      for (const page of childrenOf(pages, parentId)) {
        // pages 可能跨知识库，遍历时必须按 workspaceId 过滤；回收站内的分组由 childrenOf 排除。
        if (page.workspaceId !== ws.id || page.kind !== "group") continue;
        targets.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          parentId: page.id,
          label: page.title || "未命名分组",
          depth,
        });
        walk(page.id, depth + 1);
      }
    };
    walk(null, 1);
  }
  return targets;
}
