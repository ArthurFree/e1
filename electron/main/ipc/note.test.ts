// @vitest-environment node
/**
 * R006-C3-A（FR-12，r006-c3 §20/§41.3 handler 层）：note 组 IPC handler 测试。
 * 真实 tmp 文件系统 + 真实 VaultRegistry/TransientVaultStore（依赖注入）：
 * note.read 正常（stableNoteId 提取/markdown 原文/source 信息）、未登记与
 * transient vaultId 双通道、schema 拦截链（各非法 relativePath 形态）、
 * PathGuard 拦截链（symlink 逃逸/非 Markdown）；note.create/save 保持
 * NOT_IMPLEMENTED 契约桩。
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type ReadNoteResult,
} from "../../../shared/ipc/contracts.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import type { IpcMainLike } from "./handler.js";
import { registerNoteHandlers } from "./note.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let vaultRoot: string;

const bus: IpcMainLike = {
  handle: (channel, listener) => {
    handlers.set(channel, listener as Handler);
  },
};

function call(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册：${channel}`);
  return handler({}, payload);
}

async function readNote(
  vaultId: string,
  relativePath: string,
): Promise<IpcResult<unknown>> {
  return call(IPC_CHANNELS.noteRead, { vaultId, relativePath });
}

beforeEach(async () => {
  handlers = new Map();
  const stateDir = await mkdtemp(join(tmpdir(), "e1-note-ipc-state-"));
  registry = new VaultRegistry(join(stateDir, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-note-ipc-vault-"));
  registerNoteHandlers(bus, { registry, transients });
});

/** 登记 vaultRoot 为常规 Vault（vaultId = "v-笔记"）。 */
async function registerVault(): Promise<string> {
  await registry.touch({
    vaultId: "v-笔记",
    absolutePath: vaultRoot,
    displayName: "笔记库",
  });
  return "v-笔记";
}

describe("note.read 真实实现（FR-12）", () => {
  it("带 Frontmatter id：stableNoteId 提取 + markdown 原文 + source 信息", async () => {
    const vaultId = await registerVault();
    const markdown = "---\nid: n-1\ntitle: React\n---\n\n# React 正文\n";
    await writeFile(join(vaultRoot, "React.md"), markdown, "utf8");

    const result = await readNote(vaultId, "React.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.value as ReadNoteResult;
    expect(note.stableNoteId).toBe("n-1");
    expect(note.relativePath).toBe("React.md");
    // markdown 为磁盘原文（含 Frontmatter），不做任何归一（PR-02）。
    expect(note.markdown).toBe(markdown);
    expect(note.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(note.source.sizeBytes).toBe(Buffer.byteLength(markdown, "utf8"));
    expect(Number.isInteger(note.source.modifiedAt)).toBe(true);
  });

  it("无 Frontmatter id：stableNoteId 为 null，Main 不创建 id（PR-03）", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "笔记.md"), "# 无 id\n", "utf8");

    const result = await readNote(vaultId, "笔记.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as ReadNoteResult).stableNoteId).toBeNull();
  });

  it("CRLF 文件的 Frontmatter id 正常提取，markdown 保持 CRLF 原文", async () => {
    const vaultId = await registerVault();
    const markdown = "---\r\nid: n-crlf\r\n---\r\n\r\n正文\r\n";
    await writeFile(join(vaultRoot, "crlf.md"), markdown, "utf8");

    const result = await readNote(vaultId, "crlf.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.value as ReadNoteResult;
    expect(note.stableNoteId).toBe("n-crlf");
    expect(note.markdown).toBe(markdown);
  });

  it("未登记 vaultId → VAULT_NOT_FOUND", async () => {
    const result = await readNote("v-未登记", "a.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("transient 仅预览会话 vaultId 可读（双通道解析）", async () => {
    await writeFile(join(vaultRoot, "预览.md"), "# 预览\n", "utf8");
    const transientId = transients.add(vaultRoot, "预览库");

    const result = await readNote(transientId, "预览.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as ReadNoteResult).markdown).toBe("# 预览\n");
  });

  it("文件不存在 → NOTE_NOT_FOUND", async () => {
    const vaultId = await registerVault();
    const result = await readNote(vaultId, "不存在.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOTE_NOT_FOUND");
  });

  it("超大文件 → DOCUMENT_TOO_LARGE 信封携带 details", async () => {
    const vaultId = await registerVault();
    await writeFile(
      join(vaultRoot, "huge.md"),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
    );
    const result = await readNote(vaultId, "huge.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_TOO_LARGE");
    expect(result.error.details).toMatchObject({ maxBytes: 10 * 1024 * 1024 });
  });
});

describe("note.read 拦截链（SEC-02/03）", () => {
  it("relativePath 非法形态被 schema 拦截（PATH_ESCAPE / INVALID_INPUT）", async () => {
    const vaultId = await registerVault();
    const cases: Array<[string, string]> = [
      ["../outside.md", "PATH_ESCAPE"],
      ["/abs/x.md", "PATH_ESCAPE"],
      ["C:\\x\\a.md", "PATH_ESCAPE"],
      ["a//b.md", "PATH_ESCAPE"],
      ["a/./b.md", "PATH_ESCAPE"],
      ["  ", "INVALID_INPUT"],
    ];
    for (const [relativePath, code] of cases) {
      const result = await readNote(vaultId, relativePath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  it("入参形状非法 → INVALID_INPUT（不进入业务实现）", async () => {
    for (const payload of [null, "a.md", { vaultId: 1 }, { vaultId: "v" }]) {
      const result = await call(IPC_CHANNELS.noteRead, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("symlink 逃逸经 PathGuard 拦截 → PATH_ESCAPE", async () => {
    const vaultId = await registerVault();
    const outside = await mkdtemp(join(tmpdir(), "e1-note-ipc-outside-"));
    await writeFile(join(outside, "secret.md"), "不应可读", "utf8");
    await symlink(join(outside, "secret.md"), join(vaultRoot, "逃逸.md"));

    const result = await readNote(vaultId, "逃逸.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("非 Markdown / 目录目标 → INVALID_INPUT", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "a.txt"), "x", "utf8");
    await mkdir(join(vaultRoot, "docs.md"));

    const txt = await readNote(vaultId, "a.txt");
    expect(txt.ok).toBe(false);
    if (!txt.ok) expect(txt.error.code).toBe("INVALID_INPUT");
    const dir = await readNote(vaultId, "docs.md");
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.error.code).toBe("INVALID_INPUT");
  });
});

describe("note.create / note.save 仍为契约桩", () => {
  it("合法入参 → NOT_IMPLEMENTED", async () => {
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId: "v1",
      directory: "",
      title: "t",
    });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe("NOT_IMPLEMENTED");

    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId: "v1",
      relativePath: "a.md",
      markdown: "m",
      expectedVersionToken: "",
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("NOT_IMPLEMENTED");
  });
});
