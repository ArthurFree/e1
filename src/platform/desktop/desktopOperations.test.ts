/**
 * R007 阶段 4（§9）：RuntimeOperations 装配断言——
 * Web 全 true；Desktop 未实现的操作 false（入口隐藏）；内存容器缺省
 * webOperations 且支持覆盖（组件门控测试依赖）。
 */
import { describe, expect, it } from "vitest";
import { webOperations } from "../web/webOperations";
import { desktopOperations } from "./desktopOperations";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";

/** 深度断言对象所有叶子布尔均为 expected。 */
function expectAllBoolean(value: unknown, expected: boolean): void {
  if (typeof value === "boolean") {
    expect(value).toBe(expected);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    expectAllBoolean(child, expected);
  }
}

describe("RuntimeOperations 装配矩阵（R007 §9）", () => {
  it("Web：全部操作已实现，矩阵全 true", () => {
    expectAllBoolean(webOperations, true);
  });

  it("Desktop：未实现的操作 false（workspace.rename / page.renameFile / revision）", () => {
    expect(desktopOperations).toEqual({
      workspace: { rename: false, favorite: true },
      page: {
        createDocument: true,
        createGroup: true,
        renameTitle: true,
        renameFile: false,
        move: true,
        trash: true,
        restore: true,
        purge: true,
        favorite: true,
      },
      tag: { write: true },
      revision: { read: false, write: false },
    });
  });

  it("内存容器：缺省 webOperations（全 true），可经 options 覆盖", () => {
    const { services } = createInMemoryAppServices();
    expect(services.operations).toEqual(webOperations);

    const custom = {
      ...webOperations,
      page: { ...webOperations.page, trash: false },
    };
    const { services: overridden } = createInMemoryAppServices({
      operations: custom,
    });
    expect(overridden.operations.page.trash).toBe(false);
    expect(overridden.operations.page.move).toBe(true);
  });
});
