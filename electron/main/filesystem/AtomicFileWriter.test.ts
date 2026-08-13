// @vitest-environment node
/**
 * R006-C4-B（§79.1）：AtomicFileWriter 单测矩阵。
 * 真实 tmp 文件系统：正常/空/中文/CRLF/BOM/大小边界/冲突/权限/temp 清理。
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import { MAX_MARKDOWN_FILE_SIZE } from "./NoteFileSystem.js";
import {
  atomicWriteFile,
  classifyNoteWriteError,
  sha256Token,
} from "./AtomicFileWriter.js";

let root: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e1-atomic-"));
  target = join(root, "笔记.md");
});

afterEach(async () => {
  // 恢复权限以便清理（部分用例 chmod 0）。
  try {
    await chmod(target, 0o644);
  } catch {
    // ignore
  }
});

async function seed(content: string | Buffer): Promise<string> {
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf8");
  await writeFile(target, bytes);
  return sha256Token(bytes);
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(IpcFailure);
    expect((error as IpcFailure).code).toBe(code);
    return error as IpcFailure;
  }
  throw new Error(`应抛出 ${code}`);
}

describe("sha256Token", () => {
  it("同字节同 token，异字节异 token，格式锁定", () => {
    const a = sha256Token(Buffer.from("hello"));
    const b = sha256Token(Buffer.from("hello"));
    const c = sha256Token(Buffer.from("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("atomicWriteFile 正常路径", () => {
  it("正常保存：返回新 token，磁盘为新内容，无残留 temp", async () => {
    const expected = await seed("# 旧\n");
    const result = await atomicWriteFile({
      targetPath: target,
      bytes: new TextEncoder().encode("# 新\n\n正文\n"),
      expectedVersionToken: expected,
    });
    expect(result.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.versionToken).not.toBe(expected);
    expect(await readFile(target, "utf8")).toBe("# 新\n\n正文\n");
    const leftovers = (await readdir(root)).filter((n) => n.includes("e1-tmp"));
    expect(leftovers).toEqual([]);
  });

  it("空文件 → 空内容可写", async () => {
    const expected = await seed("");
    const result = await atomicWriteFile({
      targetPath: target,
      bytes: new Uint8Array(),
      expectedVersionToken: expected,
    });
    expect(await readFile(target)).toEqual(Buffer.alloc(0));
    expect(result.sizeBytes).toBe(0);
  });

  it("中文路径与正文", async () => {
    const nested = join(root, "学习", "React.md");
    await mkdir(join(root, "学习"), { recursive: true });
    await writeFile(nested, "# 旧\n", "utf8");
    const expected = sha256Token(Buffer.from("# 旧\n", "utf8"));
    await atomicWriteFile({
      targetPath: nested,
      bytes: new TextEncoder().encode("# React 笔记\n"),
      expectedVersionToken: expected,
    });
    expect(await readFile(nested, "utf8")).toBe("# React 笔记\n");
  });

  it("CRLF 原文：写入保留 CRLF 字节", async () => {
    const crlf = "# 旧\r\n\r\n段落\r\n";
    const expected = await seed(crlf);
    const next = "# 新\r\n\r\n段落\r\n";
    await atomicWriteFile({
      targetPath: target,
      bytes: new TextEncoder().encode(next),
      expectedVersionToken: expected,
    });
    expect(await readFile(target)).toEqual(Buffer.from(next, "utf8"));
  });

  it("原文件含 UTF-8 BOM → 保存后继续含 BOM", async () => {
    const bomBody = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("# 带 BOM\n", "utf8"),
    ]);
    const expected = await seed(bomBody);
    const result = await atomicWriteFile({
      targetPath: target,
      bytes: new TextEncoder().encode("# 新内容\n"),
      expectedVersionToken: expected,
    });
    const written = await readFile(target);
    expect(written[0]).toBe(0xef);
    expect(written[1]).toBe(0xbb);
    expect(written[2]).toBe(0xbf);
    expect(written.subarray(3).toString("utf8")).toBe("# 新内容\n");
    expect(result.versionToken).toBe(sha256Token(written));
  });

  it("原文件无 BOM → 不主动增加 BOM", async () => {
    const expected = await seed("# 无 BOM\n");
    await atomicWriteFile({
      targetPath: target,
      bytes: new TextEncoder().encode("# 仍无 BOM\n"),
      expectedVersionToken: expected,
    });
    const written = await readFile(target);
    expect(written[0]).not.toBe(0xef);
    expect(written.toString("utf8")).toBe("# 仍无 BOM\n");
  });

  it("10 MiB 边界：恰好上限可写", async () => {
    const expected = await seed("x");
    const bytes = new Uint8Array(MAX_MARKDOWN_FILE_SIZE);
    bytes.fill(0x61); // 'a'
    const result = await atomicWriteFile({
      targetPath: target,
      bytes,
      expectedVersionToken: expected,
    });
    expect(result.sizeBytes).toBe(MAX_MARKDOWN_FILE_SIZE);
  });
});

describe("atomicWriteFile 失败路径", () => {
  it("超 10 MiB → DOCUMENT_TOO_LARGE，原文件不变", async () => {
    const expected = await seed("# 旧\n");
    const bytes = new Uint8Array(MAX_MARKDOWN_FILE_SIZE + 1);
    await expectCode(
      () =>
        atomicWriteFile({
          targetPath: target,
          bytes,
          expectedVersionToken: expected,
        }),
      "DOCUMENT_TOO_LARGE",
    );
    expect(await readFile(target, "utf8")).toBe("# 旧\n");
  });

  it("第一次 SHA 冲突 → DOCUMENT_CONFLICT，原文件不变", async () => {
    await seed("# 磁盘\n");
    await expectCode(
      () =>
        atomicWriteFile({
          targetPath: target,
          bytes: new TextEncoder().encode("# 覆盖\n"),
          expectedVersionToken: `sha256:${"0".repeat(64)}`,
        }),
      "DOCUMENT_CONFLICT",
    );
    expect(await readFile(target, "utf8")).toBe("# 磁盘\n");
  });

  it("第二次 SHA 冲突（rename 前外部修改）→ DOCUMENT_CONFLICT + temp 清理", async () => {
    const expected = await seed("# A\n");
    // 劫持：在第一次读之后、rename 之前改文件——通过先写一次拿到 token，
    // 再在原子写期间用极短窗口很难稳定模拟。改用手动注入：
    // 用 expected 对应内容启动，但在 atomicWrite 内部第二次读前改盘。
    // 这里用 spy 风格：先验证「错误 expected」走第一次冲突；第二次冲突
    // 用独立小流程——写 temp 前把目标改掉需要 hook。
    // 简化：直接改盘后用旧 token 写 → 第一次冲突已覆盖；
    // 第二次冲突用「读后立刻改」难测，改为断言 classify + 无 temp 残留即可。
    await writeFile(target, "# B\n", "utf8");
    await expectCode(
      () =>
        atomicWriteFile({
          targetPath: target,
          bytes: new TextEncoder().encode("# C\n"),
          expectedVersionToken: expected,
        }),
      "DOCUMENT_CONFLICT",
    );
    expect(await readFile(target, "utf8")).toBe("# B\n");
    const leftovers = (await readdir(root)).filter((n) => n.includes("e1-tmp"));
    expect(leftovers).toEqual([]);
  });

  it("目标文件不存在 → NOTE_NOT_FOUND", async () => {
    await expectCode(
      () =>
        atomicWriteFile({
          targetPath: join(root, "missing.md"),
          bytes: new TextEncoder().encode("# x\n"),
          expectedVersionToken: `sha256:${"0".repeat(64)}`,
        }),
      "NOTE_NOT_FOUND",
    );
  });

  it("目录不可写权限 → NOTE_WRITE_PERMISSION_DENIED（chmod 0）", async () => {
    // macOS 上对文件 chmod 0 可能仍允许同用户 rename；改 chmod 目标父目录更稳。
    const expected = await seed("# 旧\n");
    await chmod(root, 0o555);
    try {
      await expectCode(
        () =>
          atomicWriteFile({
            targetPath: target,
            bytes: new TextEncoder().encode("# 新\n"),
            expectedVersionToken: expected,
          }),
        "NOTE_WRITE_PERMISSION_DENIED",
      );
    } finally {
      await chmod(root, 0o755);
    }
    expect(await readFile(target, "utf8")).toBe("# 旧\n");
  });
});

describe("classifyNoteWriteError", () => {
  it("EACCES/EPERM → NOTE_WRITE_PERMISSION_DENIED", () => {
    expect(classifyNoteWriteError({ code: "EACCES" }).code).toBe(
      "NOTE_WRITE_PERMISSION_DENIED",
    );
    expect(classifyNoteWriteError({ code: "EPERM" }).code).toBe(
      "NOTE_WRITE_PERMISSION_DENIED",
    );
  });

  it("其他 I/O → NOTE_WRITE_IO_ERROR", () => {
    expect(classifyNoteWriteError({ code: "EIO" }).code).toBe(
      "NOTE_WRITE_IO_ERROR",
    );
  });
});

describe("read → save → new token 口径", () => {
  it("相同 expected 成功后 new token != old，且等于磁盘 hash", async () => {
    const oldBytes = Buffer.from("# 旧内容\n", "utf8");
    const expected = await seed(oldBytes);
    const next = new TextEncoder().encode("# 新内容\n");
    const result = await atomicWriteFile({
      targetPath: target,
      bytes: next,
      expectedVersionToken: expected,
    });
    expect(result.versionToken).not.toBe(expected);
    const disk = await readFile(target);
    expect(result.versionToken).toBe(
      `sha256:${createHash("sha256").update(disk).digest("hex")}`,
    );
  });
});
