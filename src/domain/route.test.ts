import { describe, expect, it } from "vitest";
import { parseRoute, serializeRoute, type AppRoute } from "./route";

describe("路由序列化", () => {
  it("三种视图往返一致", () => {
    const routes: AppRoute[] = [
      { view: "start" },
      { view: "workspace", workspaceId: "ws1" },
      { view: "document", workspaceId: "ws1", pageId: "p1" },
    ];
    for (const route of routes) {
      expect(parseRoute(serializeRoute(route))).toEqual(route);
    }
  });

  it("缺失或损坏的输入返回 null", () => {
    expect(parseRoute(null)).toBeNull();
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("not json")).toBeNull();
    expect(parseRoute("{}")).toBeNull();
    expect(parseRoute('{"view":"unknown"}')).toBeNull();
    expect(parseRoute('{"view":"workspace"}')).toBeNull();
    expect(parseRoute('{"view":"document","workspaceId":"ws1"}')).toBeNull();
  });
});
