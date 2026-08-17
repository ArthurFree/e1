// @vitest-environment node
/**
 * R007 阶段 3：VaultWatcherService 集成测试（真 chokidar + 真 tmp 目录）。
 *
 * 端到端验证事件流：外部写文件 → chokidar → 分类/抑制 → 合并 → 广播。
 * chokidar 为真实异步（fsevents/awaitWriteFinish），使用真实定时器 +
 * 轮询等待，不用 vi.useFakeTimers。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultFsEvent } from "../../../shared/ipc/contracts.js";
import { sha256Token } from "../filesystem/AtomicFileWriter.js";
import { VaultWatcherService } from "./VaultWatcher.js";

/** awaitWriteFinish(200ms) + 合并窗口之外再留裕量。 */
const QUIET_MS = 700;

let root: string;
let broadcasts: VaultFsEvent[][];
let service: VaultWatcherService;

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor 超时；已收到事件：${JSON.stringify(broadcasts)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function flatEvents(): VaultFsEvent[] {
  return broadcasts.flat();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e1-watcher-int-"));
  await mkdir(join(root, ".e1"));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v-集成",
      name: "集成库",
      assetsDirectory: "assets",
    }),
  );
  broadcasts = [];
  service = new VaultWatcherService({
    onEvents: (events) => broadcasts.push(events),
    windowMs: 100,
  });
  service.ensureWatching("v-集成", root);
  // chokidar 就绪等待：每次写不同的探针文件（重复写同名文件只会产生
  // change 而非 add），直到看到任意探针的 note-created 事件。
  for (
    let attempt = 0;
    attempt < 25 &&
    !flatEvents().some(
      (e) => e.type === "note-created" && e.relativePath.startsWith("探针-"),
    );
    attempt += 1
  ) {
    await writeFile(join(root, `探针-${attempt}.md`), `# 探针 ${attempt}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await waitFor(() =>
    flatEvents().some(
      (e) => e.type === "note-created" && e.relativePath.startsWith("探针-"),
    ),
  );
  // 清理探针并等其 unlink 事件静默，之后重置事件收集。
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(root)) {
    if (name.startsWith("探针-")) await rm(join(root, name), { force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  broadcasts = [];
}, 30_000);

afterEach(async () => {
  await service.closeAll();
  await rm(root, { recursive: true, force: true });
});

describe("端到端事件流（真 chokidar）", () => {
  it("外部新增/修改/删除 .md → note-created/changed/removed 依次到达", async () => {
    await writeFile(join(root, "外部.md"), "# 外部\n");
    await waitFor(() =>
      flatEvents().some(
        (e) => e.type === "note-created" && e.relativePath === "外部.md",
      ),
    );

    broadcasts = [];
    await writeFile(join(root, "外部.md"), "# 外部 v2\n");
    await waitFor(() =>
      flatEvents().some(
        (e) => e.type === "note-changed" && e.relativePath === "外部.md",
      ),
    );

    broadcasts = [];
    await rm(join(root, "外部.md"));
    await waitFor(() =>
      flatEvents().some(
        (e) => e.type === "note-removed" && e.relativePath === "外部.md",
      ),
    );
  });

  it("assets 下外部新增 → asset-changed", async () => {
    await writeFile(join(root, "assets", "外部.png"), "png-bytes");
    await waitFor(() =>
      flatEvents().some(
        (e) =>
          e.type === "asset-changed" && e.relativePath === "assets/外部.png",
      ),
    );
  });

  it(".e1/vault.json 被外部改写 → rescan-required", async () => {
    const metaPath = join(root, ".e1", "vault.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as object;
    await writeFile(metaPath, JSON.stringify({ ...meta, name: "改名" }));
    await waitFor(() =>
      flatEvents().some(
        (e) => e.type === "rescan-required" && e.vaultId === "v-集成",
      ),
    );
  });

  it("E1 自写（先登记 token 再落盘）→ 不产生回声；随后外部再改正常出事件", async () => {
    const content = "# E1 自动保存\n";
    service.selfWrites.record({
      vaultId: "v-集成",
      relativePath: "自写.md",
      versionToken: sha256Token(Buffer.from(content, "utf8")),
    });
    await writeFile(join(root, "自写.md"), content);
    // 静默期后仍无该文件事件（自写被抑制）。
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(
      flatEvents().filter(
        (e) => "relativePath" in e && e.relativePath === "自写.md",
      ),
    ).toEqual([]);

    // watcher 仍存活：外部再改一次正常出事件。
    await writeFile(join(root, "自写.md"), "# 外部再改\n");
    await waitFor(() =>
      flatEvents().some(
        (e) =>
          (e.type === "note-changed" || e.type === "note-created") &&
          e.relativePath === "自写.md",
      ),
    );
  });

  it("AtomicFileWriter 临时文件（点开头）不产生任何事件", async () => {
    await writeFile(join(root, ".笔记.md.e1-tmp-0123456789abcdef"), "tmp");
    await writeFile(join(root, "对照.md"), "# 对照\n");
    await waitFor(() =>
      flatEvents().some(
        (e) => e.type === "note-created" && e.relativePath === "对照.md",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(
      flatEvents().filter(
        (e) => "relativePath" in e && e.relativePath.includes("e1-tmp"),
      ),
    ).toEqual([]);
  });
});
