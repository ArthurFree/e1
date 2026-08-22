/**
 * R006 阶段 1：IPC 请求校验器测试——逐契约断言合法入参通过、
 * 非法入参抛 IpcFailure（INVALID_INPUT / PATH_ESCAPE）。
 */
import { describe, expect, it } from "vitest";
import { IpcFailure } from "../errors.js";
import {
  assertRelativePath,
  parseCreateDirectoryInput,
  parseCreateNoteInput,
  parseImportAssetInput,
  parseListTrashInput,
  parseMoveNoteInput,
  parseNoInput,
  parseOpenRecentRequest,
  parseOpenSelectionRequest,
  parsePatchNoteMetadataInput,
  parsePatchVaultStateInput,
  parsePurgeTrashInput,
  parseVaultStateGetInput,
  parseReadNoteInput,
  parseRenameNoteFileInput,
  parseResolveAssetUrlInput,
  parseRestoreTrashInput,
  parseRevealAssetInput,
  parseRevealNoteInput,
  parseSaveNoteInput,
  parseSecretNameRequest,
  parseSecretSetInput,
  parseTrashInput,
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

describe("parseOpenSelectionRequest（R006-C2.1 FR-01）", () => {
  it("selectionToken + initialize 布尔通过", () => {
    expect(
      parseOpenSelectionRequest({ selectionToken: "s-1", initialize: true }),
    ).toEqual({ selectionToken: "s-1", initialize: true });
    expect(
      parseOpenSelectionRequest({ selectionToken: "s-1", initialize: false }),
    ).toEqual({ selectionToken: "s-1", initialize: false });
  });

  it("形状非法 INVALID_INPUT", () => {
    expectFailure(() => parseOpenSelectionRequest("s-1"), "INVALID_INPUT");
    expectFailure(() => parseOpenSelectionRequest({}), "INVALID_INPUT");
    expectFailure(
      () => parseOpenSelectionRequest({ selectionToken: "  ", initialize: 1 }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parseOpenSelectionRequest({ selectionToken: "s-1", initialize: "yes" }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseOpenSelectionRequest({ selectionToken: "s-1" }),
      "INVALID_INPUT",
    );
  });
});

describe("parseOpenRecentRequest（R006-C2.1 FR-02）", () => {
  it("非空 vaultId 通过", () => {
    expect(parseOpenRecentRequest({ vaultId: "v-1" })).toEqual({
      vaultId: "v-1",
    });
  });

  it("形状非法 INVALID_INPUT", () => {
    expectFailure(() => parseOpenRecentRequest("v-1"), "INVALID_INPUT");
    expectFailure(() => parseOpenRecentRequest({}), "INVALID_INPUT");
    expectFailure(
      () => parseOpenRecentRequest({ vaultId: "  " }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parseOpenRecentRequest({ vaultId: 42 }),
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

describe("parsePatchNoteMetadataInput", () => {
  const valid = {
    vaultId: "v1",
    relativePath: "a.md",
    expectedVersionToken: "sha256:abc",
    patch: { title: "新标题" },
  };

  it("title / tags / 两者同时均通过", () => {
    expect(parsePatchNoteMetadataInput(valid)).toEqual(valid);
    const tagsOnly = {
      ...valid,
      patch: { tags: ["前端", "后端"] },
    };
    expect(parsePatchNoteMetadataInput(tagsOnly)).toEqual(tagsOnly);
    const both = { ...valid, patch: { title: "t", tags: [] } };
    expect(parsePatchNoteMetadataInput(both)).toEqual(both);
  });

  it("patch 缺失/为空对象/类型错误 INVALID_INPUT", () => {
    const { patch: _omit, ...noPatch } = valid;
    expectFailure(() => parsePatchNoteMetadataInput(noPatch), "INVALID_INPUT");
    expectFailure(
      () => parsePatchNoteMetadataInput({ ...valid, patch: {} }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parsePatchNoteMetadataInput({ ...valid, patch: { title: 1 } }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parsePatchNoteMetadataInput({ ...valid, patch: { tags: ["a", 2] } }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parsePatchNoteMetadataInput({ ...valid, patch: "title" }),
      "INVALID_INPUT",
    );
  });

  it("路径逃逸 PATH_ESCAPE；缺令牌 INVALID_INPUT", () => {
    expectFailure(
      () => parsePatchNoteMetadataInput({ ...valid, relativePath: "/abs.md" }),
      "PATH_ESCAPE",
    );
    expectFailure(
      () =>
        parsePatchNoteMetadataInput({
          vaultId: "v1",
          relativePath: "a.md",
          patch: { title: "t" },
        }),
      "INVALID_INPUT",
    );
  });
});

describe("parseVaultStateGetInput / parsePatchVaultStateInput（R007 阶段 2）", () => {
  it("get：非空 vaultId 字符串通过；其余 INVALID_INPUT", () => {
    expect(parseVaultStateGetInput("v1")).toBe("v1");
    expectFailure(() => parseVaultStateGetInput(""), "INVALID_INPUT");
    expectFailure(() => parseVaultStateGetInput(42), "INVALID_INPUT");
    expectFailure(() => parseVaultStateGetInput(undefined), "INVALID_INPUT");
  });

  it("patch：pages/workspace 局部合并形状通过（null 清值）", () => {
    const pagesOnly = {
      vaultId: "v1",
      patch: { pages: { "01JABC": { favoriteAt: 123, lastOpenedAt: null } } },
    };
    expect(parsePatchVaultStateInput(pagesOnly)).toEqual(pagesOnly);
    const wsOnly = {
      vaultId: "v1",
      patch: { workspace: { favoriteAt: null } },
    };
    expect(parsePatchVaultStateInput(wsOnly)).toEqual(wsOnly);
  });

  it("patch：空 patch / 非法时间戳 / 非法形状 INVALID_INPUT", () => {
    expectFailure(
      () => parsePatchVaultStateInput({ vaultId: "v1", patch: {} }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parsePatchVaultStateInput({
          vaultId: "v1",
          patch: { pages: { p: { favoriteAt: -1 } } },
        }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parsePatchVaultStateInput({
          vaultId: "v1",
          patch: { pages: { p: { lastOpenedAt: 1.5 } } },
        }),
      "INVALID_INPUT",
    );
    expectFailure(
      () =>
        parsePatchVaultStateInput({
          vaultId: "v1",
          patch: { workspace: { favoriteAt: "now" } },
        }),
      "INVALID_INPUT",
    );
    expectFailure(
      () => parsePatchVaultStateInput({ patch: { workspace: {} } }),
      "INVALID_INPUT",
    );
  });
});

describe("parseImportAssetInput", () => {
  it("合法 pick-token 入参通过", () => {
    const input = {
      vaultId: "v1",
      fileName: "pic.png",
      mimeType: "image/png",
      source: { kind: "pick-token" as const, token: "p-token" },
    };
    expect(parseImportAssetInput(input)).toEqual(input);
  });

  it("合法 bytes 入参通过", () => {
    const data = new Uint8Array([1, 2]);
    const input = {
      vaultId: "v1",
      fileName: "pic.png",
      mimeType: "image/png",
      source: { kind: "bytes" as const, data },
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
          fileName: "",
          mimeType: "image/png",
          source: { kind: "pick-token", token: "p-token" },
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

describe("R007 阶段 4：文件操作入参校验", () => {
  describe("parseCreateDirectoryInput", () => {
    it("合法入参通过（parentRelativePath 空串 = 根目录）", () => {
      expect(
        parseCreateDirectoryInput({
          vaultId: "v-1",
          parentRelativePath: "",
          name: "学习",
        }),
      ).toEqual({ vaultId: "v-1", parentRelativePath: "", name: "学习" });
      expect(
        parseCreateDirectoryInput({
          vaultId: "v-1",
          parentRelativePath: "学习/前端",
          name: "React",
        }).parentRelativePath,
      ).toBe("学习/前端");
    });

    it("name 含路径分隔符 / 为 . 或 .. / 为空 → INVALID_INPUT", () => {
      for (const name of ["a/b", "a\\b", ".", "..", "", "  "]) {
        expectFailure(
          () =>
            parseCreateDirectoryInput({
              vaultId: "v-1",
              parentRelativePath: "",
              name,
            }),
          "INVALID_INPUT",
        );
      }
    });

    it("parentRelativePath 逃逸形态 → PATH_ESCAPE", () => {
      expectFailure(
        () =>
          parseCreateDirectoryInput({
            vaultId: "v-1",
            parentRelativePath: "../etc",
            name: "x",
          }),
        "PATH_ESCAPE",
      );
    });
  });

  describe("parseTrashInput / parseListTrashInput", () => {
    it("合法入参通过", () => {
      expect(
        parseTrashInput({ vaultId: "v-1", relativePath: "学习/React.md" }),
      ).toEqual({ vaultId: "v-1", relativePath: "学习/React.md" });
      expect(parseListTrashInput({ vaultId: "v-1" })).toEqual({
        vaultId: "v-1",
      });
    });

    it("relativePath 逃逸形态 → PATH_ESCAPE；缺 vaultId → INVALID_INPUT", () => {
      expectFailure(
        () => parseTrashInput({ vaultId: "v-1", relativePath: "/abs/a.md" }),
        "PATH_ESCAPE",
      );
      expectFailure(() => parseListTrashInput({}), "INVALID_INPUT");
    });
  });

  describe("parseRestoreTrashInput / parsePurgeTrashInput", () => {
    it("合法入参通过（purge 缺省 operationId = 清空全部）", () => {
      expect(
        parseRestoreTrashInput({ vaultId: "v-1", operationId: "op-1" }),
      ).toEqual({ vaultId: "v-1", operationId: "op-1" });
      expect(parsePurgeTrashInput({ vaultId: "v-1" })).toEqual({
        vaultId: "v-1",
      });
      expect(
        parsePurgeTrashInput({ vaultId: "v-1", operationId: "op-1" }),
      ).toEqual({ vaultId: "v-1", operationId: "op-1" });
    });

    it("operationId 空串 / 非字符串 → INVALID_INPUT", () => {
      expectFailure(
        () => parseRestoreTrashInput({ vaultId: "v-1", operationId: "" }),
        "INVALID_INPUT",
      );
      expectFailure(
        () => parsePurgeTrashInput({ vaultId: "v-1", operationId: 1 }),
        "INVALID_INPUT",
      );
    });
  });

  describe("parseMoveNoteInput", () => {
    it("合法入参通过（targetDirectory 空串 = 根目录）", () => {
      expect(
        parseMoveNoteInput({
          vaultId: "v-1",
          relativePath: "React.md",
          targetDirectory: "学习",
        }),
      ).toEqual({
        vaultId: "v-1",
        relativePath: "React.md",
        targetDirectory: "学习",
      });
      expect(
        parseMoveNoteInput({
          vaultId: "v-1",
          relativePath: "学习/React.md",
          targetDirectory: "",
        }).targetDirectory,
      ).toBe("");
    });

    it("relativePath 逃逸 → PATH_ESCAPE；缺 targetDirectory → INVALID_INPUT", () => {
      expectFailure(
        () =>
          parseMoveNoteInput({
            vaultId: "v-1",
            relativePath: "a//b.md",
            targetDirectory: "",
          }),
        "PATH_ESCAPE",
      );
      expectFailure(
        () => parseMoveNoteInput({ vaultId: "v-1", relativePath: "React.md" }),
        "INVALID_INPUT",
      );
    });
  });

  describe("parseRenameNoteFileInput", () => {
    it("合法入参通过", () => {
      expect(
        parseRenameNoteFileInput({
          vaultId: "v-1",
          relativePath: "学习/React.md",
          newName: "React 18.md",
        }),
      ).toEqual({
        vaultId: "v-1",
        relativePath: "学习/React.md",
        newName: "React 18.md",
      });
    });

    it("newName 非 .md 结尾 / 含分隔符 / 为空 → INVALID_INPUT", () => {
      for (const newName of ["a.txt", "a/b.md", "", "  "]) {
        expectFailure(
          () =>
            parseRenameNoteFileInput({
              vaultId: "v-1",
              relativePath: "a.md",
              newName,
            }),
          "INVALID_INPUT",
        );
      }
    });

    it("relativePath 逃逸 → PATH_ESCAPE", () => {
      expectFailure(
        () =>
          parseRenameNoteFileInput({
            vaultId: "v-1",
            relativePath: "../a.md",
            newName: "b.md",
          }),
        "PATH_ESCAPE",
      );
    });
  });

  describe("parseRevealNoteInput / parseRevealAssetInput（R007 阶段 5）", () => {
    it("note.reveal：文件与目录相对路径均通过；逃逸 → PATH_ESCAPE", () => {
      expect(
        parseRevealNoteInput({ vaultId: "v-1", relativePath: "学习" }),
      ).toEqual({ vaultId: "v-1", relativePath: "学习" });
      expect(
        parseRevealNoteInput({ vaultId: "v-1", relativePath: "学习/React.md" }),
      ).toEqual({ vaultId: "v-1", relativePath: "学习/React.md" });
      for (const payload of [
        { vaultId: "v-1", relativePath: "../x.md" },
        { vaultId: "v-1", relativePath: "/abs/x.md" },
        { vaultId: "v-1", relativePath: "a//b.md" },
      ]) {
        expectFailure(() => parseRevealNoteInput(payload), "PATH_ESCAPE");
      }
      expectFailure(
        () => parseRevealNoteInput({ vaultId: "v-1" }),
        "INVALID_INPUT",
      );
    });

    it("asset.reveal：assetId 必填非空", () => {
      expect(parseRevealAssetInput({ assetId: "asset:v1:v/a.png" })).toEqual({
        assetId: "asset:v1:v/a.png",
      });
      for (const payload of [{}, { assetId: "" }, { assetId: 1 }, "x"]) {
        expectFailure(() => parseRevealAssetInput(payload), "INVALID_INPUT");
      }
    });
  });

  describe("parseSecretNameRequest / parseSecretSetInput（R007 阶段 5）", () => {
    it("合法 secret 名（<域>.<键>）通过", () => {
      expect(parseSecretNameRequest("ai.apiKey")).toBe("ai.apiKey");
      expect(parseSecretNameRequest("vault-2.master-key")).toBe(
        "vault-2.master-key",
      );
    });

    it("非法 secret 名 → INVALID_INPUT", () => {
      for (const name of [
        "",
        "apiKey",
        "AI.apiKey",
        "ai..apiKey",
        "ai.api key",
        "ai.apiKey.extra.",
        `ai.${"x".repeat(200)}`,
        42,
        null,
      ]) {
        expectFailure(() => parseSecretNameRequest(name), "INVALID_INPUT");
      }
    });

    it("secret.set：合法入参通过；空值/非字符串/超长 → INVALID_INPUT", () => {
      expect(parseSecretSetInput({ name: "ai.apiKey", value: "sk-1" })).toEqual(
        { name: "ai.apiKey", value: "sk-1" },
      );
      for (const payload of [
        { name: "ai.apiKey" },
        { name: "ai.apiKey", value: "" },
        { name: "ai.apiKey", value: 42 },
        { name: "ai.apiKey", value: "x".repeat(16_385) },
        { name: "bad name", value: "v" },
        "ai.apiKey",
      ]) {
        expectFailure(() => parseSecretSetInput(payload), "INVALID_INPUT");
      }
    });
  });
});
