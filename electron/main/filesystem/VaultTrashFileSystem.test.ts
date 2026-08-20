// @vitest-environment node
/**
 * R007 阶段 4（§4.2）：VaultTrashFileSystem 测试。
 * 真实 tmp 文件系统：trash（文件/目录、stableNoteId 提取、保留区拒绝）、
 * list（空表/倒序）、restore（原路径/冲突确定性改名/父目录递归重建/
 * not found）、purge（单条/全部/not found/空 trash）。
 */
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import {
  listTrashEntries,
  purgeTrash,
  restoreTrashEntry,
  trashEntry,
} from "./VaultTrashFileSystem.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-trash-vault-"));
});

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

describe("trashEntry（删除 = rename 进 .e1/trash）", () => {
  it("删除 .md 文件：payload + meta.json 落盘，stableNoteId 从 Frontmatter 提取", async () => {
    await mkdir(join(vaultRoot, "学习"));
    const markdown = "---\nid: n-react\ntitle: React\n---\n\n# React\n";
    await writeFile(join(vaultRoot, "学习", "React.md"), markdown, "utf8");

    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "学习/React.md",
    });
    expect(await exists("学习/React.md")).toBe(false);

    const opDir = join(vaultRoot, ".e1", "trash", operationId);
    const meta = JSON.parse(
      await readFile(join(opDir, "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.version).toBe(1);
    expect(meta.originalRelativePath).toBe("学习/React.md");
    expect(meta.stableNoteId).toBe("n-react");
    expect(typeof meta.deletedAt).toBe("string");
    // payload 保留原文（rename 非复制删除）。
    expect(await readFile(join(opDir, "payload", "React.md"), "utf8")).toBe(
      markdown,
    );
  });

  it("删除目录（分组）：整目录移入 payload，无 stableNoteId", async () => {
    await mkdir(join(vaultRoot, "学习", "前端"), { recursive: true });
    await writeFile(join(vaultRoot, "学习", "前端", "a.md"), "# a\n", "utf8");

    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "学习",
    });
    expect(await exists("学习")).toBe(false);
    const opDir = join(vaultRoot, ".e1", "trash", operationId);
    expect(
      await readFile(join(opDir, "payload", "学习", "前端", "a.md"), "utf8"),
    ).toBe("# a\n");
    const meta = JSON.parse(
      await readFile(join(opDir, "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.stableNoteId).toBeUndefined();
  });

  it("保留区（.e1/assets）与不存在路径拒绝", async () => {
    await mkdir(join(vaultRoot, "assets"));
    await writeFile(join(vaultRoot, "assets", "a.png"), "x", "utf8");
    await expectFailure(
      () => trashEntry({ vaultRoot, relativePath: "assets/a.png" }),
      "VAULT_RESERVED_PATH",
    );
    await expectFailure(
      () => trashEntry({ vaultRoot, relativePath: ".e1/vault.json" }),
      "VAULT_RESERVED_PATH",
    );
    await expectFailure(
      () => trashEntry({ vaultRoot, relativePath: "不存在.md" }),
      "NOTE_NOT_FOUND",
    );
  });
});

describe("listTrashEntries", () => {
  it("无 trash 目录 → 空表", async () => {
    expect(await listTrashEntries({ vaultRoot })).toEqual([]);
  });

  it("返回条目并按 deletedAt 倒序；损坏条目容错跳过", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await writeFile(join(vaultRoot, "b.md"), "# b\n", "utf8");
    const first = await trashEntry({ vaultRoot, relativePath: "a.md" });
    // 保证 deletedAt 可区分（ISO 秒级之外还有毫秒，同毫秒时以写入次序为准不稳定——
    // 此处显式改写 meta 的 deletedAt 做确定性断言）。
    const second = await trashEntry({ vaultRoot, relativePath: "b.md" });
    const firstMetaPath = join(
      vaultRoot,
      ".e1",
      "trash",
      first.operationId,
      "meta.json",
    );
    const firstMeta = JSON.parse(await readFile(firstMetaPath, "utf8")) as {
      deletedAt: string;
    };
    firstMeta.deletedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(firstMetaPath, JSON.stringify(firstMeta), "utf8");
    // 损坏条目：非法 meta.json 应被跳过。
    const corruptDir = join(vaultRoot, ".e1", "trash", "zzzz-000000000000");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "meta.json"), "not json", "utf8");

    const entries = await listTrashEntries({ vaultRoot });
    expect(entries.map((e) => e.operationId)).toEqual([
      second.operationId,
      first.operationId,
    ]);
    expect(entries[0]!.originalRelativePath).toBe("b.md");
    expect(entries[1]!.originalRelativePath).toBe("a.md");
  });
});

describe("restoreTrashEntry（§4.2 恢复）", () => {
  it("原路径可用 → 恢复到原路径，trash 条目清除", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "React.md"), "# React\n", "utf8");
    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "学习/React.md",
    });

    const result = await restoreTrashEntry({ vaultRoot, operationId });
    expect(result.relativePath).toBe("学习/React.md");
    expect(await readFile(join(vaultRoot, "学习", "React.md"), "utf8")).toBe(
      "# React\n",
    );
    expect(await listTrashEntries({ vaultRoot })).toEqual([]);
  });

  it("原路径冲突 → 确定性改名恢复（name (2).ext），返回实际路径", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# 旧\n", "utf8");
    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "a.md",
    });
    await writeFile(join(vaultRoot, "a.md"), "# 新占位\n", "utf8");

    const result = await restoreTrashEntry({ vaultRoot, operationId });
    expect(result.relativePath).toBe("a (2).md");
    expect(await readFile(join(vaultRoot, "a (2).md"), "utf8")).toBe("# 旧\n");
    // 占位文件不被覆盖。
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("# 新占位\n");
  });

  it("原父目录已删除 → 递归重建后恢复", async () => {
    await mkdir(join(vaultRoot, "学习", "前端"), { recursive: true });
    await writeFile(
      join(vaultRoot, "学习", "前端", "React.md"),
      "# React\n",
      "utf8",
    );
    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "学习/前端/React.md",
    });
    // 删除整个原父目录链。
    await trashEntry({ vaultRoot, relativePath: "学习" });

    const result = await restoreTrashEntry({ vaultRoot, operationId });
    expect(result.relativePath).toBe("学习/前端/React.md");
    expect(await exists("学习/前端/React.md")).toBe(true);
  });

  it("目录恢复冲突 → 目录名确定性递增（name (2)）", async () => {
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "学习", "a.md"), "# a\n", "utf8");
    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "学习",
    });
    await mkdir(join(vaultRoot, "学习"));

    const result = await restoreTrashEntry({ vaultRoot, operationId });
    expect(result.relativePath).toBe("学习 (2)");
    expect(await exists("学习 (2)/a.md")).toBe(true);
  });

  it("operationId 不存在 / 格式非法 → VAULT_TRASH_NOT_FOUND / INVALID_INPUT", async () => {
    await expectFailure(
      () => restoreTrashEntry({ vaultRoot, operationId: "mabc-000000000000" }),
      "VAULT_TRASH_NOT_FOUND",
    );
    await expectFailure(
      () => restoreTrashEntry({ vaultRoot, operationId: "../escape" }),
      "INVALID_INPUT",
    );
  });
});

describe("purgeTrash（永久删除）", () => {
  it("指定 operationId 物理删除单条", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    const { operationId } = await trashEntry({
      vaultRoot,
      relativePath: "a.md",
    });
    const result = await purgeTrash({ vaultRoot, operationId });
    expect(result.purged).toBe(1);
    expect(await listTrashEntries({ vaultRoot })).toEqual([]);
    const trashRoot = join(vaultRoot, ".e1", "trash");
    expect(await readdir(trashRoot)).toEqual([]);
  });

  it("缺省 operationId 清空整个回收站，返回条目数", async () => {
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await writeFile(join(vaultRoot, "b.md"), "# b\n", "utf8");
    await trashEntry({ vaultRoot, relativePath: "a.md" });
    await trashEntry({ vaultRoot, relativePath: "b.md" });

    const result = await purgeTrash({ vaultRoot });
    expect(result.purged).toBe(2);
    expect(await listTrashEntries({ vaultRoot })).toEqual([]);
  });

  it("trash 为空/不存在 → purged 0；指定不存在条目 → VAULT_TRASH_NOT_FOUND", async () => {
    expect(await purgeTrash({ vaultRoot })).toEqual({ purged: 0 });
    await expectFailure(
      () => purgeTrash({ vaultRoot, operationId: "mabc-000000000000" }),
      "VAULT_TRASH_NOT_FOUND",
    );
  });
});
