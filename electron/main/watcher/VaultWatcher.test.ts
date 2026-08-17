// @vitest-environment node
/**
 * R007 阶段 3：VaultWatcher / VaultWatcherService 单元测试（假 watch 工厂）。
 *
 * FakeWatcher 为 EventEmitter 替身：测试手动 emit("all", kind, absPath)
 * 模拟 chokidar 事件；文件内容用真实 tmp 目录（自写抑制需要真实 hash）。
 * 覆盖：忽略规则、事件分类、自写抑制（token 比对/消费/asset 无 token）、
 * ensureWatching 幂等、closeAll、错误降级（不抛出，只广播 rescan-required）。
 */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFsEvent } from "../../../shared/ipc/contracts.js";
import { sha256Token } from "../filesystem/AtomicFileWriter.js";
import {
  classifyWatchPath,
  VaultWatcherService,
  type FSWatcherLike,
  type VaultWatchOptions,
} from "./VaultWatcher.js";

class FakeWatcher extends EventEmitter {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

let root: string;
let fakeWatchers: FakeWatcher[];
let capturedOptions: VaultWatchOptions[];
let broadcasts: VaultFsEvent[][];
let service: VaultWatcherService;

function fakeFactory(_root: string, options: VaultWatchOptions): FSWatcherLike {
  capturedOptions.push(options);
  const watcher = new FakeWatcher();
  fakeWatchers.push(watcher);
  return watcher as unknown as FSWatcherLike;
}

/** 轮询等待条件成立（事件处理含真实异步 hash，不能用假定时器）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 等待合并窗口（20ms）静默期过去。 */
async function waitFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e1-watcher-unit-"));
  await mkdir(join(root, ".e1"));
  await writeFile(
    join(root, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v-单测",
      name: "单测库",
      assetsDirectory: "assets",
    }),
  );
  fakeWatchers = [];
  capturedOptions = [];
  broadcasts = [];
  service = new VaultWatcherService({
    onEvents: (events) => broadcasts.push(events),
    watchFactory: fakeFactory,
    windowMs: 20,
  });
});

afterEach(async () => {
  await service.closeAll();
  vi.restoreAllMocks();
});

/** 启动监听并等待 chokidar 工厂真正被调用。 */
async function startWatching(vaultId = "v-单测"): Promise<FakeWatcher> {
  service.ensureWatching(vaultId, root);
  await waitFor(() => fakeWatchers.length > 0);
  return fakeWatchers[0]!;
}

describe("chokidar 配置与忽略规则", () => {
  it("watch 选项：ignoreInitial / 不跟随符号链接 / awaitWriteFinish", async () => {
    await startWatching();
    expect(capturedOptions[0]).toMatchObject({
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
  });

  it("ignored：点开头路径段忽略，.e1/vault.json 例外", async () => {
    await startWatching();
    const ignored = capturedOptions[0]!.ignored;
    expect(ignored(root)).toBe(false);
    expect(ignored(join(root, "笔记.md"))).toBe(false);
    expect(ignored(join(root, ".e1"))).toBe(false);
    expect(ignored(join(root, ".e1", "vault.json"))).toBe(false);
    // .e1 下其他内容（trash/tmp 等）忽略。
    expect(ignored(join(root, ".e1", "trash", "x.md"))).toBe(true);
    // AtomicFileWriter 临时文件（点开头段天然覆盖）。
    expect(ignored(join(root, ".笔记.md.e1-tmp-0123456789abcdef"))).toBe(true);
    expect(ignored(join(root, ".hidden", "a.md"))).toBe(true);
    expect(ignored(join(root, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(ignored(join(root, "下载.tmp"))).toBe(true);
  });
});

describe("事件分类", () => {
  it("classifyWatchPath：md → note；assets → asset；vault.json → vault-meta；其余忽略", () => {
    expect(classifyWatchPath("文档/笔记.md", "assets")).toBe("note");
    expect(classifyWatchPath("assets/pic.png", "assets")).toBe("asset");
    expect(classifyWatchPath("assets/嵌套/pic.png", "assets")).toBe("asset");
    expect(classifyWatchPath(".e1/vault.json", "assets")).toBe("vault-meta");
    expect(classifyWatchPath("说明.txt", "assets")).toBeNull();
    // 自定义 assetsDirectory。
    expect(classifyWatchPath("media/pic.png", "media")).toBe("asset");
    expect(classifyWatchPath("assets/pic.png", "media")).toBeNull();
  });

  it("add/change/unlink 分别映射 note-created/changed/removed；其余文件不出事件", async () => {
    const watcher = await startWatching();
    await writeFile(join(root, "新.md"), "# 新\n");
    watcher.emit("all", "add", join(root, "新.md"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "note-created", vaultId: "v-单测", relativePath: "新.md" },
    ]);

    watcher.emit("all", "change", join(root, "新.md"));
    await waitFor(() => broadcasts.length > 1);
    expect(broadcasts[1]).toEqual([
      { type: "note-changed", vaultId: "v-单测", relativePath: "新.md" },
    ]);

    watcher.emit("all", "unlink", join(root, "新.md"));
    await waitFor(() => broadcasts.length > 2);
    expect(broadcasts[2]).toEqual([
      { type: "note-removed", vaultId: "v-单测", relativePath: "新.md" },
    ]);

    // 不关心的文件与目录事件不产生广播。
    watcher.emit("all", "add", join(root, "说明.txt"));
    watcher.emit("all", "addDir", join(root, "新建文件夹"));
    await waitFlush();
    expect(broadcasts).toHaveLength(3);
  });

  it("assets 下文件任意变化 → asset-changed", async () => {
    const watcher = await startWatching();
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "p.png"), "png");
    watcher.emit("all", "add", join(root, "assets", "p.png"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "asset-changed", vaultId: "v-单测", relativePath: "assets/p.png" },
    ]);
  });

  it(".e1/vault.json 变化 → rescan-required", async () => {
    const watcher = await startWatching();
    watcher.emit("all", "change", join(root, ".e1", "vault.json"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "rescan-required", vaultId: "v-单测" },
    ]);
  });

  it("自定义 assetsDirectory（vault.json 读取）生效", async () => {
    await writeFile(
      join(root, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-单测",
        name: "单测库",
        assetsDirectory: "media",
      }),
    );
    const watcher = await startWatching();
    await mkdir(join(root, "media"));
    await writeFile(join(root, "media", "p.png"), "png");
    watcher.emit("all", "add", join(root, "media", "p.png"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "asset-changed", vaultId: "v-单测", relativePath: "media/p.png" },
    ]);
  });
});

describe("自写抑制（进 coalescer 之前）", () => {
  it("note：token 匹配 → 抑制且消费；之后再次变化正常出事件", async () => {
    const watcher = await startWatching();
    const content = "# 自写内容\n";
    await writeFile(join(root, "笔记.md"), content);
    service.selfWrites.record({
      vaultId: "v-单测",
      relativePath: "笔记.md",
      versionToken: sha256Token(await readFile(join(root, "笔记.md"))),
    });
    watcher.emit("all", "change", join(root, "笔记.md"));
    await waitFlush();
    expect(broadcasts).toEqual([]);

    // 记录已消费：同样的变化再次到达 → 正常出事件。
    watcher.emit("all", "change", join(root, "笔记.md"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "note-changed", vaultId: "v-单测", relativePath: "笔记.md" },
    ]);
  });

  it("note：磁盘内容与记录 token 不等（外部又改过）→ 不抑制", async () => {
    const watcher = await startWatching();
    await writeFile(join(root, "笔记.md"), "# 外部修改\n");
    service.selfWrites.record({
      vaultId: "v-单测",
      relativePath: "笔记.md",
      versionToken: "sha256:不等于磁盘内容",
    });
    watcher.emit("all", "change", join(root, "笔记.md"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0][0]).toMatchObject({ type: "note-changed" });
  });

  it("asset：无 token 记录直接抑制 import 回声", async () => {
    const watcher = await startWatching();
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "导入.png"), "png");
    service.selfWrites.record({
      vaultId: "v-单测",
      relativePath: "assets/导入.png",
    });
    watcher.emit("all", "add", join(root, "assets", "导入.png"));
    await waitFlush();
    expect(broadcasts).toEqual([]);
  });
});

describe("VaultWatcherService 生命周期", () => {
  it("ensureWatching 幂等：同 vaultId 只建一个 watcher", async () => {
    await startWatching();
    service.ensureWatching("v-单测", root);
    await waitFlush();
    expect(fakeWatchers).toHaveLength(1);
    expect(service.isWatching("v-单测")).toBe(true);
    expect(service.isWatching("v-别的")).toBe(false);
  });

  it("closeAll 关闭全部 watcher 并清空状态", async () => {
    const watcher = await startWatching();
    await service.closeAll();
    expect(watcher.closed).toBe(true);
    expect(service.isWatching("v-单测")).toBe(false);
  });

  it("watcher error → console.warn + 广播 rescan-required（不抛出）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = await startWatching();
    watcher.emit("error", new Error("模拟监听错误"));
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([
      { type: "rescan-required", vaultId: "v-单测" },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it("watch 工厂抛错 → console.warn + 广播 rescan-required，且不视为在监听", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new VaultWatcherService({
      onEvents: (events) => broadcasts.push(events),
      watchFactory: () => {
        throw new Error("目录不可达");
      },
      windowMs: 20,
    });
    failing.ensureWatching("v-坏", root);
    await waitFor(() => broadcasts.length > 0);
    expect(broadcasts[0]).toEqual([{ type: "rescan-required", vaultId: "v-坏" }]);
    expect(failing.isWatching("v-坏")).toBe(false);
    expect(warn).toHaveBeenCalled();
    await failing.closeAll();
  });
});
