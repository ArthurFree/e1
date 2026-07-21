import type { Page, Workspace } from "./types";
import { childrenOf } from "./pageTree";

export interface PickerTarget {
  workspaceId: string;
  workspaceName: string;
  parentId: string | null;
  label: string;
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
