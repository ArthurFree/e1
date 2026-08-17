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
import { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
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

describe("note.create / note.save 真实实现（R006-C4）", () => {
  it("note.create：默认 Frontmatter + exclusive 文件名；冲突递增", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "React.md"), "# taken\n", "utf8");

    const first = await call(IPC_CHANNELS.noteCreate, {
      vaultId,
      directory: "",
      title: "Hello",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const created = first.value as {
      noteId: string;
      relativePath: string;
      versionToken: string;
      source?: { modifiedAt: number; sizeBytes: number };
    };
    expect(created.relativePath).toBe("Hello.md");
    expect(created.noteId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    const { readFile } = await import("node:fs/promises");
    const disk = await readFile(join(vaultRoot, "Hello.md"), "utf8");
    expect(disk).toContain(`id: ${created.noteId}`);
    expect(disk).toContain("title: Hello");
    expect(disk).toContain("tags: []");

    const conflict = await call(IPC_CHANNELS.noteCreate, {
      vaultId,
      directory: "",
      title: "React",
    });
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    expect(
      (conflict.value as { relativePath: string }).relativePath,
    ).toBe("React (2).md");
  });

  it("note.create：自定义 markdown 已有 id → 沿用，response.noteId === 磁盘 id", async () => {
    const vaultId = await registerVault();
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId,
      directory: "",
      title: "导入",
      markdown: [
        "---",
        "id: existing-from-caller",
        "title: 导入",
        "custom_field: keep-me",
        "---",
        "",
        "自定义正文",
        "",
      ].join("\n"),
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const created = create.value as { noteId: string; relativePath: string };
    expect(created.noteId).toBe("existing-from-caller");
    const { readFile } = await import("node:fs/promises");
    const disk = await readFile(join(vaultRoot, created.relativePath), "utf8");
    expect(disk).toContain("id: existing-from-caller");
    expect(disk).toContain("custom_field: keep-me");
    expect(disk).toContain("自定义正文");
  });

  it("note.create：自定义 markdown 无 id → 注入 generatedId，与磁盘一致", async () => {
    const vaultId = await registerVault();
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId,
      directory: "",
      title: "无 id",
      markdown: "# 只有正文\n",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const created = create.value as { noteId: string; relativePath: string };
    expect(created.noteId.length).toBeGreaterThan(0);
    const { readFile } = await import("node:fs/promises");
    const disk = await readFile(join(vaultRoot, created.relativePath), "utf8");
    expect(disk).toContain(`id: ${created.noteId}`);
    expect(disk).toContain("# 只有正文");
  });

  it("note.create：transient Vault → VAULT_READ_ONLY", async () => {
    const transientId = transients.add(vaultRoot, "预览库");
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId: transientId,
      directory: "",
      title: "t",
    });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe("VAULT_READ_ONLY");
  });

  it("note.save：正常写盘 → 新 versionToken + source，磁盘内容更新", async () => {
    const vaultId = await registerVault();
    const original = "# 旧\n";
    await writeFile(join(vaultRoot, "a.md"), original, "utf8");
    const read = await readNote(vaultId, "a.md");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const token = (read.value as ReadNoteResult).versionToken;

    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId,
      relativePath: "a.md",
      markdown: "# 新\n\n正文\n",
      expectedVersionToken: token,
    });
    expect(save.ok).toBe(true);
    if (!save.ok) return;
    const result = save.value as {
      versionToken: string;
      source: { modifiedAt: number; sizeBytes: number };
    };
    expect(result.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.versionToken).not.toBe(token);
    expect(result.source.sizeBytes).toBeGreaterThan(0);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe(
      "# 新\n\n正文\n",
    );
  });

  it("note.save：expected 与磁盘不一致 → DOCUMENT_CONFLICT，原文件不变", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "b.md"), "# 磁盘\n", "utf8");
    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId,
      relativePath: "b.md",
      markdown: "# 覆盖\n",
      expectedVersionToken: `sha256:${"0".repeat(64)}`,
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("DOCUMENT_CONFLICT");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(vaultRoot, "b.md"), "utf8")).toBe("# 磁盘\n");
  });

  it("note.save：transient Vault → VAULT_READ_ONLY，hash 不变", async () => {
    await writeFile(join(vaultRoot, "预览.md"), "# 预览\n", "utf8");
    const transientId = transients.add(vaultRoot, "预览库");
    const before = await readNote(transientId, "预览.md");
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const token = (before.value as ReadNoteResult).versionToken;

    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId: transientId,
      relativePath: "预览.md",
      markdown: "# 试图写入\n",
      expectedVersionToken: token,
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("VAULT_READ_ONLY");

    const after = await readNote(transientId, "预览.md");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect((after.value as ReadNoteResult).versionToken).toBe(token);
    expect((after.value as ReadNoteResult).markdown).toBe("# 预览\n");
  });

  it("note.save：超大 markdown → DOCUMENT_TOO_LARGE", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "c.md"), "# c\n", "utf8");
    const read = await readNote(vaultId, "c.md");
    if (!read.ok) return;
    const huge = "a".repeat(10 * 1024 * 1024 + 1);
    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId,
      relativePath: "c.md",
      markdown: huge,
      expectedVersionToken: (read.value as ReadNoteResult).versionToken,
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("DOCUMENT_TOO_LARGE");
  });
});

describe("R007 阶段 3：写成功登记自写（watcher 回声抑制挂点）", () => {
  function withSelfWrites(): SelfWriteRegistry {
    const selfWrites = new SelfWriteRegistry();
    handlers = new Map();
    registerNoteHandlers(bus, { registry, transients, selfWrites });
    return selfWrites;
  }

  it("note.save 成功 → 以入参 relativePath + 新 versionToken 记录", async () => {
    const selfWrites = withSelfWrites();
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "a.md"), "# 旧\n", "utf8");
    const read = await readNote(vaultId, "a.md");
    if (!read.ok) throw new Error("read 应成功");
    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId,
      relativePath: "a.md",
      markdown: "# 新\n",
      expectedVersionToken: (read.value as ReadNoteResult).versionToken,
    });
    expect(save.ok).toBe(true);
    if (!save.ok) return;
    const newToken = (save.value as { versionToken: string }).versionToken;
    // 记录命中即抑制（消费语义：第二次 false）。
    expect(selfWrites.shouldSuppress(vaultId, "a.md", newToken)).toBe(true);
    expect(selfWrites.shouldSuppress(vaultId, "a.md", newToken)).toBe(false);
  });

  it("note.create 成功 → 以结果 relativePath + versionToken 记录", async () => {
    const selfWrites = withSelfWrites();
    const vaultId = await registerVault();
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId,
      directory: "",
      title: "回声",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const created = create.value as {
      relativePath: string;
      versionToken: string;
    };
    expect(
      selfWrites.shouldSuppress(
        vaultId,
        created.relativePath,
        created.versionToken,
      ),
    ).toBe(true);
  });

  it("note.patchMetadata 成功 → 记录；保存失败（冲突）不记录", async () => {
    const selfWrites = withSelfWrites();
    const vaultId = await registerVault();
    await writeFile(
      join(vaultRoot, "m.md"),
      "---\nid: n-m\ntitle: 旧标题\n---\n\n正文\n",
      "utf8",
    );
    const read = await readNote(vaultId, "m.md");
    if (!read.ok) throw new Error("read 应成功");
    const token = (read.value as ReadNoteResult).versionToken;

    const patch = await call(IPC_CHANNELS.notePatchMetadata, {
      vaultId,
      relativePath: "m.md",
      expectedVersionToken: token,
      patch: { title: "新标题" },
    });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const newToken = (patch.value as { versionToken: string }).versionToken;
    expect(selfWrites.shouldSuppress(vaultId, "m.md", newToken)).toBe(true);

    // 冲突失败不写盘也不登记。
    const conflict = await call(IPC_CHANNELS.noteSave, {
      vaultId,
      relativePath: "m.md",
      markdown: "# x\n",
      expectedVersionToken: `sha256:${"0".repeat(64)}`,
    });
    expect(conflict.ok).toBe(false);
    expect(selfWrites.size).toBe(0);
  });
});
