/**
 * R006 阶段 1：IPC 请求校验器测试——逐契约断言合法入参通过、
 * 非法入参抛 IpcFailure（INVALID_INPUT / PATH_ESCAPE）。
 */
import { describe, expect, it } from "vitest";
import { IpcFailure } from "../errors.js";
import {
  assertRelativePath,
  parseCreateNoteInput,
  parseImportAssetInput,
  parseNoInput,
  parseOpenVaultRequest,
  parseReadNoteInput,
  parseResolveAssetUrlInput,
  parseSaveNoteInput,
  parseVaultScanRequest,
} from "./schemas.js";

/** 断言抛 IpcFailure 且 code 匹配。 */
function expectFailure(
  fn: () => unknown,
  code: "INVALID_INPUT" | "PATH_ESCAPE",
) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IpcFailure);
    expect((error as IpcFailure).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 IpcFailure，实际未抛");
}

describe("parseNoInput", () => {
  it("undefined/null 通过", () => {
    expect(parseNoInput(undefined)).toBeUndefined();
    expect(parseNoInput(null)).toBeUndefined();
  });

  it("携带任何负载即 INVALID_INPUT", () => {
    expectFailure(() => parseNoInput({}), "INVALID_INPUT");
    expectFailure(() => parseNoInput("x"), "INVALID_INPUT");
  });
});

describe("parseVaultScanRequest", () => {
  it("非空 vaultId 字符串通过", () => {
    expect(parseVaultScanRequest("vault-1")).toBe("vault-1");
  });

  it("空串/非字符串 INVALID_INPUT", () => {
    expectFailure(() => parseVaultScanRequest(""), "INVALID_INPUT");
    expectFailure(() => parseVaultScanRequest("  "), "INVALID_INPUT");
    expectFailure(() => parseVaultScanRequest(42), "INVALID_INPUT");
    expectFailure(
      () => parseVaultScanRequest({ vaultId: "v" }),
      "INVALID_INPUT",
    );
  });
});

describe("parseOpenVaultRequest（R006 阶段 2）", () => {
  it("absolutePath 必填；name 可选", () => {
    expect(parseOpenVaultRequest({ absolutePath: "/x/笔记" })).toEqual({
      absolutePath: "/x/笔记",
    });
    expect(
      parseOpenVaultRequest({ absolutePath: "/x/笔记", name: "我的库" }),
    ).toEqual({ absolutePath: "/x/笔记", name: "我的库" });
  });

  it("形状非法 INVALID_INPUT", () => {
    expectFailure(() => parseOpenVaultRequest("/x"), "INVALID_INPUT");
    expectFailure(() => parseOpenVaultRequest({}), "INVALID_INPUT");
    expectFailure(
      () => parseOpenVaultRequest({ absolutePath: "  " }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseOpenVaultRequest({ absolutePath: "/x", name: 42 }),
      "INVALID_INPUT",
    );
  });
});

describe("assertRelativePath", () => {
  it("常规相对路径通过", () => {
    expect(assertRelativePath("学习/React.md")).toBe("学习/React.md");
    expect(assertRelativePath("a/b/c.md")).toBe("a/b/c.md");
  });

  it("绝对路径/盘符/逃逸段/空段一律 PATH_ESCAPE", () => {
    for (const bad of [
      "/etc/passwd",
      "\\abs\\x.md",
      "C:\\notes\\a.md",
      "d:/notes/a.md",
      "../escape.md",
      "a/../../b.md",
      "a//b.md",
      "./a.md",
      "a/./b.md",
    ]) {
      expectFailure(() => assertRelativePath(bad), "PATH_ESCAPE");
    }
  });

  it("空串 INVALID_INPUT", () => {
    expectFailure(() => assertRelativePath(""), "INVALID_INPUT");
  });
});

describe("parseReadNoteInput", () => {
  it("合法入参通过", () => {
    expect(
      parseReadNoteInput({ vaultId: "v1", relativePath: "学习/React.md" }),
    ).toEqual({ vaultId: "v1", relativePath: "学习/React.md" });
  });

  it("非对象/缺字段/错类型 INVALID_INPUT", () => {
    expectFailure(() => parseReadNoteInput("v1"), "INVALID_INPUT");
    expectFailure(
      () => parseReadNoteInput({ relativePath: "a.md" }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseReadNoteInput({ vaultId: 1, relativePath: "a.md" }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseReadNoteInput({ vaultId: "", relativePath: "a.md" }),
      "INVALID_INPUT",
    );
  });

  it("路径逃逸 PATH_ESCAPE", () => {
    expectFailure(
      () => parseReadNoteInput({ vaultId: "v1", relativePath: "../x.md" }),
      "PATH_ESCAPE",
    );
  });
});

describe("parseCreateNoteInput", () => {
  it("合法入参通过（directory 允许空串 = 根目录）", () => {
    expect(
      parseCreateNoteInput({ vaultId: "v1", directory: "", title: "无标题" }),
    ).toEqual({ vaultId: "v1", directory: "", title: "无标题" });
    expect(
      parseCreateNoteInput({
        vaultId: "v1",
        directory: "学习",
        title: "t",
        markdown: "# hi",
      }),
    ).toEqual({
      vaultId: "v1",
      directory: "学习",
      title: "t",
      markdown: "# hi",
    });
  });

  it("markdown 缺省不进结果；非字符串 INVALID_INPUT", () => {
    const parsed = parseCreateNoteInput({
      vaultId: "v1",
      directory: "",
      title: "t",
    });
    expect("markdown" in parsed).toBe(false);
    expectFailure(
      () =>
        parseCreateNoteInput({
          vaultId: "v1",
          directory: "",
          title: "t",
          markdown: 1,
        }),
      "INVALID_INPUT",
    );
  });

  it("缺 vaultId/title、directory 逃逸分别报错", () => {
    expectFailure(
      () => parseCreateNoteInput({ directory: "", title: "t" }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseCreateNoteInput({ vaultId: "v1", directory: "", title: 3 }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parseCreateNoteInput({ vaultId: "v1", directory: "../x", title: "t" }),
      "PATH_ESCAPE",
    );
  });
});

describe("parseSaveNoteInput", () => {
  const valid = {
    vaultId: "v1",
    relativePath: "a.md",
    markdown: "# t",
    expectedVersionToken: "sha256:abc",
  };

  it("合法入参通过；初始令牌空串允许", () => {
    expect(parseSaveNoteInput(valid)).toEqual(valid);
    expect(parseSaveNoteInput({ ...valid, expectedVersionToken: "" })).toEqual({
      ...valid,
      expectedVersionToken: "",
    });
  });

  it("缺字段/错类型 INVALID_INPUT", () => {
    expectFailure(
      () => parseSaveNoteInput({ ...valid, markdown: 1 }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parseSaveNoteInput({
          vaultId: "v1",
          relativePath: "a.md",
          markdown: "m",
        }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseSaveNoteInput({ ...valid, expectedVersionToken: null }),
      "INVALID_INPUT",
    );
  });

  it("路径逃逸 PATH_ESCAPE", () => {
    expectFailure(
      () => parseSaveNoteInput({ ...valid, relativePath: "/abs.md" }),
      "PATH_ESCAPE",
    );
  });
});

describe("parseImportAssetInput", () => {
  it("合法入参通过", () => {
    const input = {
      vaultId: "v1",
      sourceAbsolutePath: "/Users/x/pic.png",
      fileName: "pic.png",
    };
    expect(parseImportAssetInput(input)).toEqual(input);
  });

  it("缺字段/空串 INVALID_INPUT", () => {
    expectFailure(
      () => parseImportAssetInput({ vaultId: "v1", fileName: "a.png" }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parseImportAssetInput({
          vaultId: "v1",
          sourceAbsolutePath: "/x/a.png",
          fileName: "",
        }),
      "INVALID_INPUT",
    );
  });
});

describe("parseResolveAssetUrlInput", () => {
  it("非空 assetId 字符串通过", () => {
    expect(parseResolveAssetUrlInput("asset-1")).toBe("asset-1");
  });

  it("空串/非字符串 INVALID_INPUT", () => {
    expectFailure(() => parseResolveAssetUrlInput(""), "INVALID_INPUT");
    expectFailure(() => parseResolveAssetUrlInput({}), "INVALID_INPUT");
  });
});
