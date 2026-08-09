// @vitest-environment node
/**
 * R006 阶段 2：PathGuard 防护矩阵测试（真实 tmp 文件系统 + 真实符号链接）。
 *
 * 覆盖：嵌套正常解析（含中文）、".." 各形态、绝对路径/盘符/UNC 注入、
 * 反斜杠形态、空段/"." 段、符号链接逃逸（目录 symlink 指出 Vault 外）、
 * 根内 symlink（realpath 仍在根内 → 放行）、同前缀兄弟目录边界
 * （/vault 与 /vault-evil）、不存在目标（读取语义 → NOTE_NOT_FOUND）、
 * assertSafeFileName 全部分支。
 */
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import { assertSafeFileName, resolveWithinVault } from "./PathGuard.js";

let root: string;

/** 每个用例独立 Vault 根（内含 学习/React.md 与 工作/ 目录）。 */
async function makeVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e1-pathguard-"));
  await mkdir(join(dir, "学习"), { recursive: true });
  await mkdir(join(dir, "工作"));
  await writeFile(join(dir, "学习", "React.md"), "# React");
  await writeFile(join(dir, "README.md"), "# README");
  return dir;
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`应抛出 ${code}，实际成功`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(IpcFailure);
      expect((error as IpcFailure).code).toBe(code);
    },
  );
}

describe("resolveWithinVault 正常解析", () => {
  it("根目录文件与嵌套中文路径解析为根内真实路径", async () => {
    root = await makeVault();
    const rootReal = await realpath(root);
    await expect(resolveWithinVault(root, "README.md")).resolves.toBe(
      join(rootReal, "README.md"),
    );
    await expect(resolveWithinVault(root, "学习/React.md")).resolves.toBe(
      join(rootReal, "学习", "React.md"),
    );
  });

  it("Vault 根本身经符号链接时仍可解析（两侧 realpath 对齐）", async () => {
    const base = await mkdtemp(join(tmpdir(), "e1-pathguard-link-"));
    const real = join(base, "real-vault");
    await mkdir(real);
    await writeFile(join(real, "a.md"), "a");
    const link = join(base, "link-vault");
    await symlink(real, link, "dir");
    await expect(resolveWithinVault(link, "a.md")).resolves.toBe(
      join(await realpath(real), "a.md"),
    );
  });

  it("根内符号链接指向根内目标 → 放行", async () => {
    root = await makeVault();
    await symlink(join(root, "学习"), join(root, "学习链接"), "dir");
    await expect(resolveWithinVault(root, "学习链接/React.md")).resolves.toBe(
      join(await realpath(root), "学习", "React.md"),
    );
  });
});

describe("resolveWithinVault 静态形态拒绝（PATH_ESCAPE）", () => {
  it.each([
    ["../outside.md", "上级逃逸"],
    ["a/../../b.md", "中段 .. 逃逸"],
    ["..", "纯 .."],
    ["a/./b.md", "'.' 段"],
    ["a//b.md", "空段"],
    ["/etc/passwd", "POSIX 绝对路径"],
    ["C:\\Windows\\system.ini", "盘符绝对路径"],
    ["\\\\server\\share", "UNC 路径"],
    ["..\\..\\escape.md", "反斜杠 .. 逃逸"],
    ["  ", "纯空白"],
  ])("拒绝 %s（%s）", async (input) => {
    root = await makeVault();
    await expectCode(resolveWithinVault(root, input), "PATH_ESCAPE");
  });
});

describe("resolveWithinVault realpath 层防护", () => {
  it("目录符号链接指出 Vault 外 → PATH_ESCAPE", async () => {
    root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), "e1-pathguard-out-"));
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(root, "外链"), "dir");
    await expectCode(resolveWithinVault(root, "外链/secret.md"), "PATH_ESCAPE");
  });

  it("文件符号链接指出 Vault 外 → PATH_ESCAPE", async () => {
    root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), "e1-pathguard-out-"));
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(join(outside, "secret.md"), join(root, "偷渡.md"));
    await expectCode(resolveWithinVault(root, "偷渡.md"), "PATH_ESCAPE");
  });

  it("同前缀兄弟目录不构成根内（/vault 与 /vault-evil 分隔符边界）", async () => {
    const base = await mkdtemp(join(tmpdir(), "e1-pathguard-pre-"));
    const vault = join(base, "vault");
    const evil = join(base, "vault-evil");
    await mkdir(vault);
    await mkdir(evil);
    await writeFile(join(evil, "x.md"), "x");
    // 经 symlink 把 vault-evil 挂进 vault 内，realpath 后以 "vault-evil"
    // 为前缀——若只做字符串前缀比较会误判为根内，分隔符边界拦下。
    await symlink(evil, join(vault, "evil-link"), "dir");
    await expectCode(
      resolveWithinVault(vault, "evil-link/x.md"),
      "PATH_ESCAPE",
    );
  });

  it("目标不存在（读取语义）→ NOTE_NOT_FOUND", async () => {
    root = await makeVault();
    await expectCode(
      resolveWithinVault(root, "不存在/也没有.md"),
      "NOTE_NOT_FOUND",
    );
  });

  it("Vault 根不存在 → 抛错（不静默通过）", async () => {
    await expect(
      resolveWithinVault(join(tmpdir(), "e1-不存在的根-xyz"), "a.md"),
    ).rejects.toThrow();
  });
});

describe("assertSafeFileName", () => {
  it("合法中文/英文/含空格与点的名字通过", () => {
    expect(() => assertSafeFileName("React Fiber.md")).not.toThrow();
    expect(() => assertSafeFileName("学习笔记 2026")).not.toThrow();
    expect(() => assertSafeFileName("v1.2 设计.md")).not.toThrow();
  });

  it.each([
    ["", "空名"],
    ["   ", "纯空白"],
    ["a/b.md", "含斜杠"],
    ["a\\b.md", "含反斜杠"],
    ["a:b.md", "含冒号"],
    ['a*b?".md', "含通配/引号"],
    ["a<b>|c.md", "含尖括号/管道"],
    ["a	b.md", "含控制字符"],
    [" name.md", "首空格"],
    ["name.md ", "尾空格"],
    ["name.", "结尾点"],
    ["CON", "保留名"],
    ["con.txt", "保留名小写带扩展"],
    ["LPT1", "保留名 LPT"],
    ["NUL", "保留名 NUL"],
    ["超".repeat(90), "超 255 字节（90×3=270）"],
  ])("拒绝 %j（%s）", (name) => {
    try {
      assertSafeFileName(name as string);
      throw new Error("应抛出 INVALID_INPUT");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcFailure);
      expect((error as IpcFailure).code).toBe("INVALID_INPUT");
    }
  });
});
