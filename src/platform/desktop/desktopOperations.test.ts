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

describe("RuntimeOperations 装配矩阵（R007 §9 / R011 Stage 0）", () => {
  it("Web：除 document.renameFile 外全 true（IndexedDB 无物理文件名）", () => {
    expect(webOperations.page.document.renameFile).toBe(false);
    const { renameFile: _ignored, ...restDocument } =
      webOperations.page.document;
    expectAllBoolean(restDocument, true);
    expectAllBoolean(webOperations.workspace, true);
    expectAllBoolean(webOperations.page.group, true);
    expectAllBoolean(webOperations.page.trash, true);
    expectAllBoolean(webOperations.tag, true);
    expectAllBoolean(webOperations.revision, true);
  });

  it("Desktop：R011 路径操作已开启（revision 仍 false）", () => {
    expect(desktopOperations).toEqual({
      workspace: { rename: true, favorite: true },
      page: {
        document: {
          create: true,
          renameTitle: true,
          renameFile: true,
          move: true,
          trash: true,
          favorite: true,
        },
        group: {
          create: true,
          rename: true,
          move: true,
          trash: true,
        },
        trash: { restore: true, purge: true },
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
      page: {
        ...webOperations.page,
        document: { ...webOperations.page.document, trash: false },
      },
    };
    const { services: overridden } = createInMemoryAppServices({
      operations: custom,
    });
    expect(overridden.operations.page.document.trash).toBe(false);
    expect(overridden.operations.page.document.move).toBe(true);
  });
});
