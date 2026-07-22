/**
 * 主区域视图路由：序列化后存入 preferences.lastRoute，启动时恢复上次位置。
 * 解析对坏数据零容忍——任何形状不符（含 JSON 解析失败、字段缺失或类型不对）
 * 都返回 null，由调用方回退到开始首页，避免损坏的持久化数据卡死启动。
 */

/** 主区域视图路由：持久化到 preferences.lastRoute，启动时恢复。 */
export type AppRoute =
  /** 开始首页。 */
  | { view: "start" }
  /** 最近浏览。 */
  | { view: "recent" }
  /** 收藏页。 */
  | { view: "favorites" }
  /** 知识库首页。 */
  | { view: "workspace"; workspaceId: string }
  /** 文档编辑。 */
  | { view: "document"; workspaceId: string; pageId: string };

/** 序列化为 JSON 字符串，供持久化。 */
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
