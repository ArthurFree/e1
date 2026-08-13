// @vitest-environment node
/**
 * R006 阶段 2：VaultFileSystem 测试（真实 tmp 文件系统）。
 *
 * 覆盖：readVault 未初始化/合法/坏 JSON/坏 format/不支持的 formatVersion
 * （损坏时不修改任何文件）；R006-C2.1（FR-04 / §41.2）错误分类——EACCES
 * （chmod 000 真实模拟）/EPERM/其他 I/O（classifyVaultReadError 纯函数）
 * 与 assertVaultRootDirectory 同步分类；initializeVault 创建 vault.json + assets/、
 * 幂等、name 缺省回退目录名；scanVault 树映射（中文名/嵌套/同名不同目录/
 * 无 Frontmatter/有 Frontmatter id·title·tags/非 md 混入/.e1·隐藏目录·
 * node_modules 跳过/符号链接不跟随）、group 身份与 parentPath、
 * 排序确定性（group 在前 + zh-CN 比较器）、100+ 文件 smoke。
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import type { VaultScanEntry } from "../../../shared/ipc/contracts.js";
import { initializeVault, readVault, scanVault } from "./VaultFileSystem.js";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e1-vaultfs-"));
}

function expectInvalid(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => {
      throw new Error("应抛出 INVALID_INPUT，实际成功");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(IpcFailure);
      expect((error as IpcFailure).code).toBe("INVALID_INPUT");
    },
  );
}

describe("readVault", () => {
  it("无 .e1/vault.json → uninitialized + suggestedName 取目录名", async () => {
    const root = join(await makeDir(), "我的笔记");
    await mkdir(root);
    const result = await readVault(root);
    expect(result).toEqual({
      status: "uninitialized",
      suggestedName: "我的笔记",
    });
  });

  it("合法 vault.json → initialized + meta 全字段", async () => {
    const root = await makeDir();
    await mkdir(join(root, ".e1"));
    await writeFile(
      join(root, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-1",
        name: "知识库",
        createdAt: "2026-08-09T16:00:00+08:00",
        assetsDirectory: "assets",
        identityMode: "frontmatter",
      }),
    );
    const result = await readVault(root);
    expect(result.status).toBe("initialized");
    if (result.status === "initialized") {
      expect(result.meta.vaultId).toBe("v-1");
      expect(result.meta.name).toBe("知识库");
      expect(result.meta.createdAt).toBe("2026-08-09T16:00:00+08:00");
    }
  });

  it.each([
    ["{ 坏 JSON", "坏 JSON"],
    [JSON.stringify({ format: "other", formatVersion: 1 }), "format 不符"],
    [
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 2,
        vaultId: "v",
        name: "n",
      }),
      "formatVersion 不支持",
    ],
    [
      JSON.stringify({ format: "e1-vault", formatVersion: 1, name: "n" }),
      "vaultId 缺失",
    ],
  ])("非法 vault.json（%s）→ INVALID_INPUT 且文件原样保留", async (content) => {
    const root = await makeDir();
    await mkdir(join(root, ".e1"));
    const file = join(root, ".e1", "vault.json");
    await writeFile(file, content);
    await expectInvalid(readVault(root));
    // 损坏时不修改任何文件（US-01/防数据破坏）。
    expect(await readFile(file, "utf8")).toBe(content);
  });

  // R006-C2.1（FR-04 / r006-c3 §41.2）：读取失败按 FS error code 分类，
  // 绝不自动初始化/重建/修复（SEC-07）。
  it("EACCES（.e1 目录无权限）→ VAULT_PERMISSION_DENIED，不创建任何文件", async () => {
    const root = await makeDir();
    const e1Dir = join(root, ".e1");
    await mkdir(e1Dir);
    await writeFile(
      join(e1Dir, "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-1",
        name: "库",
      }),
    );
    const { chmod } = await import("node:fs/promises");
    await chmod(e1Dir, 0o000);
    try {
      const error = await readVault(root).then(
        () => {
          throw new Error("应抛 VAULT_PERMISSION_DENIED");
        },
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(IpcFailure);
      expect((error as IpcFailure).code).toBe("VAULT_PERMISSION_DENIED");
      expect((error as IpcFailure).message).toBe(
        "无法读取该文件夹，请检查文件或目录访问权限。",
      );
    } finally {
      // 恢复权限，保证临时目录可清理。
      await chmod(e1Dir, 0o755);
    }
  });

  it("EPERM / 其他 I/O 的分类（classifyVaultReadError 纯函数）", async () => {
    const { classifyVaultReadError } = await import("./VaultFileSystem.js");
    // ENOENT → null（未初始化，由 readVault 转 uninitialized）。
    expect(classifyVaultReadError({ code: "ENOENT" })).toBeNull();
    // EPERM → VAULT_PERMISSION_DENIED。
    const perm = classifyVaultReadError({ code: "EPERM" });
    expect(perm).toBeInstanceOf(IpcFailure);
    expect(perm?.code).toBe("VAULT_PERMISSION_DENIED");
    // 其他 I/O（EIO/无 code 的未知错误）→ VAULT_IO_ERROR。
    const io = classifyVaultReadError({ code: "EIO" });
    expect(io?.code).toBe("VAULT_IO_ERROR");
    expect(io?.message).toBe("读取知识库时发生系统错误，请重新尝试。");
    const unknown = classifyVaultReadError(new Error("奇怪的错误"));
    expect(unknown?.code).toBe("VAULT_IO_ERROR");
  });

  it("assertVaultRootDirectory：EACCES → VAULT_PERMISSION_DENIED，ENOENT → VAULT_NOT_FOUND", async () => {
    const { assertVaultRootDirectory } = await import("./VaultFileSystem.js");
    const root = await makeDir();
    // stat 目标目录需要其父目录的读/执行权限——锁定父目录制造 EACCES。
    const parent = join(root, "锁定父目录");
    await mkdir(join(parent, "目标"), { recursive: true });
    const { chmod } = await import("node:fs/promises");
    await chmod(parent, 0o000);
    try {
      const denied = await assertVaultRootDirectory(join(parent, "目标")).then(
        () => {
          throw new Error("应抛 VAULT_PERMISSION_DENIED");
        },
        (e: unknown) => e,
      );
      expect((denied as IpcFailure).code).toBe("VAULT_PERMISSION_DENIED");
    } finally {
      // 恢复权限，保证临时目录可清理。
      await chmod(parent, 0o755);
    }
    const missing = await assertVaultRootDirectory(join(root, "不存在")).then(
      () => {
        throw new Error("应抛 VAULT_NOT_FOUND");
      },
      (e: unknown) => e,
    );
    expect((missing as IpcFailure).code).toBe("VAULT_NOT_FOUND");
  });
});

describe("initializeVault", () => {
  it("创建 .e1/vault.json 与 assets/，name 缺省取目录名", async () => {
    const root = join(await makeDir(), "新建库");
    await mkdir(root);
    const meta = await initializeVault(root);
    expect(meta.format).toBe("e1-vault");
    expect(meta.formatVersion).toBe(1);
    expect(meta.vaultId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.name).toBe("新建库");
    expect(meta.assetsDirectory).toBe("assets");
    expect(meta.identityMode).toBe("frontmatter");
    // 落盘内容可回读且一致。
    const onDisk = JSON.parse(
      await readFile(join(root, ".e1", "vault.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk.vaultId).toBe(meta.vaultId);
  });

  it("显式 name 覆盖目录名", async () => {
    const root = await makeDir();
    const meta = await initializeVault(root, "我的工作台");
    expect(meta.name).toBe("我的工作台");
  });

  it("幂等：已初始化时返回既有 meta，不覆写 vaultId", async () => {
    const root = await makeDir();
    const first = await initializeVault(root, "库");
    const second = await initializeVault(root, "改名也没用");
    expect(second).toEqual(first);
  });

  it("vault.json 损坏时不静默重建（抛 INVALID_INPUT）", async () => {
    const root = await makeDir();
    await mkdir(join(root, ".e1"));
    await writeFile(join(root, ".e1", "vault.json"), "{ 坏");
    await expectInvalid(initializeVault(root));
  });
});

/** 构造一棵含各类边界形态的 Vault 树。 */
async function makeVaultTree(): Promise<string> {
  const root = await makeDir();
  await mkdir(join(root, "学习", "前端"), { recursive: true });
  await mkdir(join(root, "工作"));
  await mkdir(join(root, ".e1"));
  await mkdir(join(root, ".hidden"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "README.md"), "# 说明\n");
  await writeFile(
    join(root, "学习", "React.md"),
    "---\nid: note-react\ntitle: React Fiber\ntags: [前端, 框架]\n---\n\n正文\n",
  );
  await writeFile(join(root, "学习", "前端", "CSS.md"), "# CSS\n");
  // 同名文件位于不同目录。
  await writeFile(join(root, "学习", "笔记.md"), "无 Frontmatter 学习笔记\n");
  await writeFile(join(root, "工作", "笔记.md"), "无 Frontmatter 工作笔记\n");
  // 非 md 文件混入（不收录）。
  await writeFile(join(root, "工作", "表格.xlsx"), "fake");
  await writeFile(join(root, "图片.png"), "fake");
  // 应被跳过的目录内容。
  await writeFile(join(root, ".e1", "internal.md"), "x");
  await writeFile(join(root, ".hidden", "hide.md"), "x");
  await writeFile(join(root, "node_modules", "dep.md"), "x");
  return root;
}

describe("scanVault 映射", () => {
  it("文件夹 → group、.md → document，parentPath 链接整棵树", async () => {
    const root = await makeVaultTree();
    const { entries } = await scanVault(root);
    const byPath = new Map(entries.map((e) => [e.relativePath, e]));

    const expected: [string, VaultScanEntry["kind"], string | null][] = [
      ["学习", "group", null],
      ["学习/前端", "group", "学习"],
      ["工作", "group", null],
      ["README.md", "document", null],
      ["学习/React.md", "document", "学习"],
      ["学习/前端/CSS.md", "document", "学习/前端"],
      ["学习/笔记.md", "document", "学习"],
      ["工作/笔记.md", "document", "工作"],
    ];
    expect(entries).toHaveLength(expected.length);
    for (const [path, kind, parentPath] of expected) {
      const entry = byPath.get(path);
      expect(entry, path).toBeDefined();
      expect(entry?.kind).toBe(kind);
      expect(entry?.parentPath).toBe(parentPath);
    }
  });

  it("Frontmatter 提取 id/title/tags；缺失回退文件名", async () => {
    const root = await makeVaultTree();
    const { entries } = await scanVault(root);
    const byPath = new Map(entries.map((e) => [e.relativePath, e]));

    expect(byPath.get("学习/React.md")).toMatchObject({
      noteId: "note-react",
      title: "React Fiber",
      tags: ["前端", "框架"],
    });
    expect(byPath.get("README.md")).toMatchObject({
      noteId: null,
      title: "README",
      tags: [],
    });
    // 同名不同目录互不混淆。
    expect(byPath.get("学习/笔记.md")?.title).toBe("笔记");
    expect(byPath.get("工作/笔记.md")?.title).toBe("笔记");
    // group 恒无 noteId，tags 为空。
    expect(byPath.get("学习")).toMatchObject({ noteId: null, tags: [] });
  });

  it("跳过 .e1/隐藏目录/node_modules/非 md 文件；符号链接不跟随", async () => {
    const root = await makeVaultTree();
    // 目录 symlink 指向 Vault 外（其内容不得被扫入）。
    const outside = await makeDir();
    await writeFile(join(outside, "外部.md"), "x");
    await symlink(outside, join(root, "外链目录"), "dir");
    await symlink(join(root, "README.md"), join(root, "链接.md"));

    const { entries } = await scanVault(root);
    const paths = entries.map((e) => e.relativePath);
    expect(paths.join()).not.toMatch(/\.e1|\.hidden|node_modules/);
    expect(paths).not.toContain("外链目录");
    expect(paths).not.toContain("链接.md");
    expect(paths).not.toContain("外部.md");
    expect(paths.join()).not.toMatch(/表格|图片/);
  });

  it("排序确定性：每目录先 group 后 document，各按 zh-CN 名称序", async () => {
    const root = await makeVaultTree();
    const first = await scanVault(root);
    const second = await scanVault(root);
    expect(first).toEqual(second);
    // 顶层：group（学习、工作）在前，document（README.md）在后；
    // zh-CN 比较器下「学习」(xué) 排在「工作」(gōng) 后——拼音序。
    expect(first.entries.map((e) => e.relativePath).slice(0, 5)).toEqual([
      "工作",
      "工作/笔记.md",
      "学习",
      "学习/前端",
      "学习/前端/CSS.md",
    ]);
  });

  it("未初始化目录也可扫描：vault.vaultId 为 null，name 取目录名", async () => {
    const root = join(await makeDir(), "纯 Markdown 文件夹");
    await mkdir(root);
    await writeFile(join(root, "a.md"), "a");
    const result = await scanVault(root);
    expect(result.vault).toEqual({
      vaultId: null,
      name: "纯 Markdown 文件夹",
      assetsDirectory: null,
    });
    expect(result.entries).toHaveLength(1);
  });

  it("已初始化 Vault：vault 元信息来自 vault.json", async () => {
    const root = await makeDir();
    const meta = await initializeVault(root, "我的库");
    const result = await scanVault(root);
    expect(result.vault).toEqual({
      vaultId: meta.vaultId,
      name: "我的库",
      assetsDirectory: "assets",
    });
    // .e1/ 自身不被扫描。
    expect(result.entries).toHaveLength(0);
  });

  it("扫描不修改用户文件夹（无 .e1 被创建、文件内容不变）", async () => {
    const root = await makeVaultTree();
    await scanVault(root);
    const { readdir } = await import("node:fs/promises");
    // makeVaultTree 在 .e1 里放了 internal.md——验证扫描没有增删任何内容。
    expect(await readdir(join(root, ".e1"))).toEqual(["internal.md"]);
    expect(await readFile(join(root, "学习", "React.md"), "utf8")).toContain(
      "note-react",
    );
  });

  it("100+ 文件 smoke：扫描完成且条目数正确（计时只记录不卡阈值）", async () => {
    const root = await makeDir();
    for (let d = 0; d < 10; d++) {
      const dir = join(root, `分组${d}`);
      await mkdir(dir);
      for (let f = 0; f < 10; f++) {
        await writeFile(
          join(dir, `笔记${f}.md`),
          `---\nid: n-${d}-${f}\n---\n\n正文 ${d}/${f}\n`,
        );
      }
    }
    const start = performance.now();
    const result = await scanVault(root);
    const elapsed = performance.now() - start;
    // 10 group + 100 document。
    expect(result.entries).toHaveLength(110);
    expect(
      result.entries.filter((e) => e.kind === "document" && e.noteId === null),
    ).toHaveLength(0);
    console.log(`scanVault 110 条目耗时 ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(10_000); // 只证明可用，不设性能门槛。
  });
});
