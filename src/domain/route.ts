/** 主区域视图路由：持久化到 preferences.lastRoute，启动时恢复。 */
export type AppRoute =
  | { view: "start" }
  | { view: "recent" }
  | { view: "favorites" }
  | { view: "workspace"; workspaceId: string }
  | { view: "document"; workspaceId: string; pageId: string };

export function serializeRoute(route: AppRoute): string {
  return JSON.stringify(route);
}

/** 解析持久化路由；缺失或形状非法时返回 null（调用方回退到开始首页）。 */
export function parseRoute(raw: string | null): AppRoute | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<
      { view: string; workspaceId: unknown; pageId: unknown }
    >;
    if (parsed.view === "start") return { view: "start" };
    if (parsed.view === "recent") return { view: "recent" };
    if (parsed.view === "favorites") return { view: "favorites" };
    if (parsed.view === "workspace" && typeof parsed.workspaceId === "string") {
      return { view: "workspace", workspaceId: parsed.workspaceId };
    }
    if (
      parsed.view === "document" &&
      typeof parsed.workspaceId === "string" &&
      typeof parsed.pageId === "string"
    ) {
      return {
        view: "document",
        workspaceId: parsed.workspaceId,
        pageId: parsed.pageId,
      };
    }
    return null;
  } catch {
    return null;
  }
}
