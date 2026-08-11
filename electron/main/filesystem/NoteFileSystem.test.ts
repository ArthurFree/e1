// @vitest-environment node
/**
 * R006-C3-A（FR-06~FR-11，r006-c3 §41.3/§41.4）：NoteFileSystem 测试。
 * 真实 tmp 文件系统：路径/扩展名/大小边界/编码/symlink 防护全矩阵 +
 * SHA256 版本令牌口径（同字节同 token、异字节异 token、格式锁定）+
 * classifyNoteReadError 纯函数错误分类（FR-23/24/25）。
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import {
  classifyNoteReadError,
  MAX_MARKDOWN_FILE_SIZE,
  readNoteFile,
} from "./NoteFileSystem.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e1-note-fs-"));
});

/** 在 Vault 根下写文件（自动建父目录），返回写入字节。 */
async function writeNote(
  relativePath: string,
  content: string | Buffer,
): Promise<Buffer> {
  const absolute = join(root, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf8");
  await writeFile(absolute, bytes);
  return bytes;
}

/** 读取并断言抛指定 code 的 IpcFailure，返回该错误供细节断言。 */
async function expectFailure(
  relativePath: string,
  code: string,
): Promise<IpcFailure> {
  try {
    await readNoteFile({ vaultRoot: root, relativePath });
  } catch (error) {
    expect(error).toBeInstanceOf(IpcFailure);
    expect((error as IpcFailure).code).toBe(code);
    return error as IpcFailure;
  }
  throw new Error(`应抛出 ${code}，但读取成功了`);
}

describe("readNoteFile 正常读取（§41.3）", () => {
  it("根目录 Markdown", async () => {
    await writeNote("README.md", "# 说明\n");
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "README.md",
    });
    expect(result.markdown).toBe("# 说明\n");
  });

  it("嵌套 Markdown", async () => {
    await writeNote("学习/React.md", "# React\n\n正文\n");
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "学习/React.md",
    });
    expect(result.markdown).toBe("# React\n\n正文\n");
  });

  it("中文路径与中文文件名", async () => {
    await writeNote("笔记/工作/周报.md", "周报内容");
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "笔记/工作/周报.md",
    });
    expect(result.markdown).toBe("周报内容");
  });

  it("空文件：markdown 为空串，token 为空字节序列的 SHA-256", async () => {
    await writeNote("empty.md", "");
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "empty.md",
    });
    expect(result.markdown).toBe("");
    expect(result.sizeBytes).toBe(0);
    expect(result.versionToken).toBe(
      `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("hex")}`,
    );
  });

  it("UTF-8 中文内容（含 emoji 与多字节混排）", async () => {
    const content = "# 标题 📝\n\n简体中文与 English 混排。\n";
    await writeNote("utf8.md", content);
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "utf8.md",
    });
    expect(result.markdown).toBe(content);
  });

  it("UTF-8 BOM：剥离 BOM 后解码；token 对含 BOM 的原始字节计算", async () => {
    const bytes = await writeNote(
      "bom.md",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("# 带 BOM\n", "utf8"),
      ]),
    );
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "bom.md",
    });
    expect(result.markdown).toBe("# 带 BOM\n");
    expect(result.markdown.charCodeAt(0)).not.toBe(0xfeff);
    // 字节口径锁定：hash 覆盖磁盘原始字节（含 BOM）。
    expect(result.versionToken).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  it("扩展名大小写混合放行（.MD / .Md）", async () => {
    // macOS 默认大小写不敏感：基名须不同，避免两名指向同一文件。
    await writeNote("大写.MD", "大写扩展名");
    await writeNote("混合.Md", "混合扩展名");
    const upper = await readNoteFile({
      vaultRoot: root,
      relativePath: "大写.MD",
    });
    const mixed = await readNoteFile({
      vaultRoot: root,
      relativePath: "混合.Md",
    });
    expect(upper.markdown).toBe("大写扩展名");
    expect(mixed.markdown).toBe("混合扩展名");
  });

  it("modifiedAt 为 ms 整数且与 stat 一致；sizeBytes 为写入字节数", async () => {
    const bytes = await writeNote("meta.md", "一二三四五"); // 15 字节
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "meta.md",
    });
    const stats = await stat(join(root, "meta.md"));
    expect(result.sizeBytes).toBe(bytes.length);
    expect(Number.isInteger(result.modifiedAt)).toBe(true);
    expect(Math.abs(result.modifiedAt - stats.mtimeMs)).toBeLessThan(1);
  });
});

describe("readNoteFile 拒绝形态（§41.3）", () => {
  it("文件不存在 → NOTE_NOT_FOUND", async () => {
    await expectFailure("不存在.md", "NOTE_NOT_FOUND");
  });

  it("目标是目录（目录名以 .md 结尾）→ INVALID_INPUT", async () => {
    await mkdir(join(root, "docs.md"));
    await expectFailure("docs.md", "INVALID_INPUT");
  });

  it("非 Markdown：.markdown / .txt / 无扩展名 → INVALID_INPUT", async () => {
    await writeNote("a.markdown", "x");
    await writeNote("a.txt", "x");
    await writeNote("a", "x");
    await expectFailure("a.markdown", "INVALID_INPUT");
    await expectFailure("a.txt", "INVALID_INPUT");
    await expectFailure("a", "INVALID_INPUT");
  });

  it("恰好 10 MiB 放行", async () => {
    await writeNote("limit.md", Buffer.alloc(MAX_MARKDOWN_FILE_SIZE, 0x61));
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "limit.md",
    });
    expect(result.sizeBytes).toBe(MAX_MARKDOWN_FILE_SIZE);
    expect(result.markdown).toHaveLength(MAX_MARKDOWN_FILE_SIZE);
  });

  it("10 MiB + 1 → DOCUMENT_TOO_LARGE，details 携带 sizeBytes/maxBytes", async () => {
    await writeNote("huge.md", Buffer.alloc(MAX_MARKDOWN_FILE_SIZE + 1, 0x61));
    const error = await expectFailure("huge.md", "DOCUMENT_TOO_LARGE");
    expect(error.details).toEqual({
      sizeBytes: MAX_MARKDOWN_FILE_SIZE + 1,
      maxBytes: MAX_MARKDOWN_FILE_SIZE,
    });
  });

  it("symlink 指向 Vault 内 Markdown → 放行（realpath 后仍在根内）", async () => {
    await writeNote("真实.md", "真实内容");
    await symlink(join(root, "真实.md"), join(root, "链接.md"));
    const result = await readNoteFile({
      vaultRoot: root,
      relativePath: "链接.md",
    });
    expect(result.markdown).toBe("真实内容");
  });

  it("symlink 以 .md 名义指向 Vault 内非 Markdown → INVALID_INPUT", async () => {
    await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x01]));
    await symlink(join(root, "data.bin"), join(root, "伪装.md"));
    await expectFailure("伪装.md", "INVALID_INPUT");
  });

  it("symlink 指出 Vault 根 → PATH_ESCAPE（SEC-03）", async () => {
    const outside = await mkdtemp(join(tmpdir(), "e1-note-outside-"));
    await writeFile(join(outside, "secret.md"), "不应可读");
    await symlink(join(outside, "secret.md"), join(root, "逃逸.md"));
    await expectFailure("逃逸.md", "PATH_ESCAPE");
  });

  it("路径逃逸各形态 → PATH_ESCAPE", async () => {
    await writeNote("a/b.md", "x");
    for (const relativePath of [
      "../outside.md",
      "a/../../outside.md",
      "a//b.md", // 空段
      "a/./b.md", // "." 段
      "a/../b.md", // ".." 段
      "/etc/passwd.md", // POSIX 绝对
      "C:\\windows\\x.md", // 盘符
      "a\\..\\b.md", // 反斜杠注入
    ]) {
      await expectFailure(relativePath, "PATH_ESCAPE");
    }
  });

  it("目录不可读权限分类：chmod 0 的 Markdown → NOTE_PERMISSION_DENIED", async () => {
    // root 用户下 chmod 不生效（可读本机开发场景跳过）；分类纯函数另有专测。
    if (process.getuid?.() === 0) return;
    await writeNote("no-read.md", "secret");
    await chmod(join(root, "no-read.md"), 0o000);
    try {
      await expectFailure("no-read.md", "NOTE_PERMISSION_DENIED");
    } finally {
      await chmod(join(root, "no-read.md"), 0o644);
    }
  });
});

describe("SHA256 版本令牌（§41.4 / FR-11）", () => {
  it("相同字节 → token 完全相同（两个文件 / 同一文件两次读取）", async () => {
    await writeNote("x.md", "相同内容");
    await writeNote("y.md", "相同内容");
    const x1 = await readNoteFile({ vaultRoot: root, relativePath: "x.md" });
    const x2 = await readNoteFile({ vaultRoot: root, relativePath: "x.md" });
    const y = await readNoteFile({ vaultRoot: root, relativePath: "y.md" });
    expect(x1.versionToken).toBe(x2.versionToken);
    expect(x1.versionToken).toBe(y.versionToken);
  });

  it("任意字节变化 → token 变化", async () => {
    await writeNote("x.md", "内容 A");
    await writeNote("y.md", "内容 B");
    const x = await readNoteFile({ vaultRoot: root, relativePath: "x.md" });
    const y = await readNoteFile({ vaultRoot: root, relativePath: "y.md" });
    expect(x.versionToken).not.toBe(y.versionToken);
  });

  it("格式固定为 sha256:<64 小写 hex>", async () => {
    await writeNote("x.md", "格式校验");
    const { versionToken } = await readNoteFile({
      vaultRoot: root,
      relativePath: "x.md",
    });
    expect(versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("UTF-8 编码检查（FR-10）", () => {
  it("GBK 字节样本（「中文」的 GBK 编码）→ UNSUPPORTED_ENCODING", async () => {
    // 「中文」GBK = D6 D0 CE C4：D0 不是合法 UTF-8 续字节，fatal 解码必失败。
    await writeNote("gbk.md", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    await expectFailure("gbk.md", "UNSUPPORTED_ENCODING");
  });

  it("孤立续字节 / 截断的多字节序列 → UNSUPPORTED_ENCODING", async () => {
    await writeNote("bad1.md", Buffer.from([0x61, 0x80, 0x62]));
    await expectFailure("bad1.md", "UNSUPPORTED_ENCODING");
    await writeNote("bad2.md", Buffer.from([0xe4, 0xb8])); // 三字节序列截断
    await expectFailure("bad2.md", "UNSUPPORTED_ENCODING");
  });
});

describe("classifyNoteReadError 错误分类（FR-23/24/25）", () => {
  it("ENOENT/ENOTDIR → null（调用方按 NOTE_NOT_FOUND 处理）", () => {
    expect(classifyNoteReadError({ code: "ENOENT" })).toBeNull();
    expect(classifyNoteReadError({ code: "ENOTDIR" })).toBeNull();
  });

  it("EACCES/EPERM → NOTE_PERMISSION_DENIED", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const failure = classifyNoteReadError({ code });
      expect(failure?.code).toBe("NOTE_PERMISSION_DENIED");
      expect(failure?.message).toContain("读取权限");
    }
  });

  it("其他 I/O → NOTE_IO_ERROR（文案声明文件未被修改）", () => {
    const failure = classifyNoteReadError({ code: "EIO" });
    expect(failure?.code).toBe("NOTE_IO_ERROR");
    expect(failure?.message).toContain("文件本身没有被修改");
  });
});
