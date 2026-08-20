// @vitest-environment node
/**
 * R007 阶段 4（§4.1/§4.3/§4.4）：VaultFileOperations 测试。
 * 真实 tmp 文件系统：新建目录（保留名拒绝/嵌套/确定性冲突递增）、
 * move（保留区拒绝/冲突报错/嵌套目标/no-op/noise）、renameFile
 * （非 .md 拒绝/冲突/no-op）。
 */
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import {
  createVaultDirectory,
  moveNoteFile,
  renameNoteFile,
} from "./VaultFileOperations.js";

let vaultRoot: string;

beforeEach(async () => {
  // 未初始化目录即可：resolveAssetsDirectory 对无 vault.json 回退默认 "assets"。
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-file-ops-vault-"));
});

/** 断言抛 IpcFailure 且 code 匹配。 */
async function expectFailure(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IpcFailure);
    expect((error as IpcFailure).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 IpcFailure(${code})，实际未抛`);
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(join(vaultRoot, ...relativePath.split("/")));
    return true;
  } catch {
    return false;
  }
}

describe("createVaultDirectory（§4.1 新建分组）", () => {
  it("根级新建目录", async () => {
    const result = await createVaultDirectory({
      vaultRoot,
      parentRelativePath: "",
      name: "学习",
    });
    expect(result.relativePath).toBe("学习");
    expect((await stat(join(vaultRoot, "学习"))).isDirectory()).toBe(true);
  });

  it("嵌套父目录下新建", async () => {
    await mkdir(join(vaultRoot, "学习"));
    const result = await createVaultDirectory({
      vaultRoot,
      parentRelativePath: "学习",
      name: "前端",
    });
    expect(result.relativePath).toBe("学习/前端");
    expect(await exists("学习/前端")).toBe(true);
  });

  it("同名冲突确定性递增：学习 → 学习 (2) → 学习 (3)", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await mkdir(join(vaultRoot, "学习 (2)"));
    const result = await createVaultDirectory({
      vaultRoot,
      parentRelativePath: "",
      name: "学习",
    });
    expect(result.relativePath).toBe("学习 (3)");
    expect(await exists("学习 (3)")).toBe(true);
  });

  it("根级保留名拒绝：.e1 / assets（大小写不敏感）→ VAULT_RESERVED_PATH", async () => {
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "",
          name: ".e1",
        }),
      "VAULT_RESERVED_PATH",
    );
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "",
          name: "Assets",
        }),
      "VAULT_RESERVED_PATH",
    );
  });

  it("父目录在保留区内拒绝（.e1 / assets）→ VAULT_RESERVED_PATH", async () => {
    await mkdir(join(vaultRoot, ".e1"));
    await mkdir(join(vaultRoot, "assets"));
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "assets",
          name: "x",
        }),
      "VAULT_RESERVED_PATH",
    );
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: ".e1",
          name: "x",
        }),
      "VAULT_RESERVED_PATH",
    );
  });

  it("点开头名称拒绝（隐藏目录不进页面树）→ INVALID_INPUT", async () => {
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "",
          name: ".hidden",
        }),
      "INVALID_INPUT",
    );
  });

  it("父目录不存在 → NOTE_NOT_FOUND；父路径是文件 → INVALID_INPUT", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "不存在",
          name: "x",
        }),
      "NOTE_NOT_FOUND",
    );
    await expectFailure(
      () =>
        createVaultDirectory({
          vaultRoot,
          parentRelativePath: "a.md",
          name: "x",
        }),
      "INVALID_INPUT",
    );
  });
});

describe("moveNoteFile（§4.3 移动文档）", () => {
  it("移动到嵌套目录，纯 rename 内容不变", async () => {
    await mkdir(join(vaultRoot, "学习", "前端"), { recursive: true });
    const markdown = "---\nid: n-1\n---\n\n# React\n";
    await writeFile(join(vaultRoot, "React.md"), markdown, "utf8");

    const result = await moveNoteFile({
      vaultRoot,
      relativePath: "React.md",
      targetDirectory: "学习/前端",
    });
    expect(result.relativePath).toBe("学习/前端/React.md");
    expect(await exists("React.md")).toBe(false);
    expect(await exists("学习/前端/React.md")).toBe(true);
  });

  it("移动到根目录（targetDirectory 空串）", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "a.md"), "# a\n", "utf8");
    const result = await moveNoteFile({
      vaultRoot,
      relativePath: "学习/a.md",
      targetDirectory: "",
    });
    expect(result.relativePath).toBe("a.md");
    expect(await exists("a.md")).toBe(true);
  });

  it("目标同名冲突 → VAULT_PATH_COLLISION（不自动改名）", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "a.md"), "# 源\n", "utf8");
    await writeFile(join(vaultRoot, "学习", "a.md"), "# 目标\n", "utf8");
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "a.md",
          targetDirectory: "学习",
        }),
      "VAULT_PATH_COLLISION",
    );
    // 源文件未被移动。
    expect(await exists("a.md")).toBe(true);
  });

  it("目标为保留区（assets）→ VAULT_RESERVED_PATH；源在保留区同样拒绝", async () => {
    await mkdir(join(vaultRoot, "assets"));
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "a.md"), "# a\n", "utf8");
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "学习/a.md",
          targetDirectory: "assets",
        }),
      "VAULT_RESERVED_PATH",
    );
    await writeFile(join(vaultRoot, "assets", "b.md"), "# b\n", "utf8");
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "assets/b.md",
          targetDirectory: "学习",
        }),
      "VAULT_RESERVED_PATH",
    );
  });

  it("源已在目标目录 → no-op 返回现状路径", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "a.md"), "# a\n", "utf8");
    const result = await moveNoteFile({
      vaultRoot,
      relativePath: "学习/a.md",
      targetDirectory: "学习",
    });
    expect(result.relativePath).toBe("学习/a.md");
    expect(await exists("学习/a.md")).toBe(true);
  });

  it("源为目录 / 非 .md 文件 / 不存在 → INVALID_INPUT / NOTE_NOT_FOUND", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await mkdir(join(vaultRoot, "目标"));
    await writeFile(join(vaultRoot, "note.txt"), "x", "utf8");
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "学习",
          targetDirectory: "目标",
        }),
      "INVALID_INPUT",
    );
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "note.txt",
          targetDirectory: "目标",
        }),
      "INVALID_INPUT",
    );
    await expectFailure(
      () =>
        moveNoteFile({
          vaultRoot,
          relativePath: "不存在.md",
          targetDirectory: "目标",
        }),
      "NOTE_NOT_FOUND",
    );
  });
});

describe("renameNoteFile（§4.4 重命名文件）", () => {
  it("同目录 rename，返回新相对路径", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "React.md"), "# React\n", "utf8");
    const result = await renameNoteFile({
      vaultRoot,
      relativePath: "学习/React.md",
      newName: "React 18.md",
    });
    expect(result.relativePath).toBe("学习/React 18.md");
    expect(await exists("学习/React.md")).toBe(false);
    expect(await exists("学习/React 18.md")).toBe(true);
  });

  it("newName 非 .md 结尾 → INVALID_INPUT（Main 侧复核，不只靠 schema）", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await expectFailure(
      () =>
        renameNoteFile({
          vaultRoot,
          relativePath: "a.md",
          newName: "a.txt",
        }),
      "INVALID_INPUT",
    );
    expect(await exists("a.md")).toBe(true);
  });

  it("同目录同名冲突 → VAULT_PATH_COLLISION", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await writeFile(join(vaultRoot, "b.md"), "# b\n", "utf8");
    await expectFailure(
      () =>
        renameNoteFile({
          vaultRoot,
          relativePath: "a.md",
          newName: "b.md",
        }),
      "VAULT_PATH_COLLISION",
    );
    expect(await exists("a.md")).toBe(true);
  });

  it("新旧同名 → no-op；保留区内文件拒绝", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    const result = await renameNoteFile({
      vaultRoot,
      relativePath: "a.md",
      newName: "a.md",
    });
    expect(result.relativePath).toBe("a.md");

    await mkdir(join(vaultRoot, ".e1"), { recursive: true });
    await writeFile(join(vaultRoot, ".e1", "x.md"), "# x\n", "utf8");
    await expectFailure(
      () =>
        renameNoteFile({
          vaultRoot,
          relativePath: ".e1/x.md",
          newName: "y.md",
        }),
      "VAULT_RESERVED_PATH",
    );
  });

  it("源为非 .md / 目录 → INVALID_INPUT", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "note.txt"), "x", "utf8");
    await expectFailure(
      () =>
        renameNoteFile({
          vaultRoot,
          relativePath: "note.txt",
          newName: "note.md",
        }),
      "INVALID_INPUT",
    );
    await expectFailure(
      () =>
        renameNoteFile({
          vaultRoot,
          relativePath: "学习",
          newName: "工作.md",
        }),
      "INVALID_INPUT",
    );
  });
});
