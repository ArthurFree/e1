// @vitest-environment node
/**
 * R011 Stage 2：JournaledFileOperationEngine 基础路径——rewrite + move + rollback。
 * R011.1（R11C-01~05）：journal v2 恢复语义——四象限判定、case-only 逐跳
 * crash、commit 窗口、partial rollback、corrupt/旧版本不静默跳过。
 */
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as fsRename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Token } from "./AtomicFileWriter.js";
import {
  executeFileOperationPlan,
  recoverPendingFileOperations,
} from "./JournaledFileOperationEngine.js";
import { journalDir } from "./FileOperationJournal.js";
import type {
  FileOperationJournal,
  FileOperationJournalPhase,
  JournalPathStep,
} from "../../../shared/fileOperations/journal.js";
import type { FileOperationPlan } from "../../../shared/fileOperations/types.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-journal-op-"));
  await mkdir(join(vaultRoot, ".e1"), { recursive: true });
  await writeFile(
    join(vaultRoot, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v-test",
      name: "测试",
      createdAt: "2026-09-03T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
    "utf8",
  );
});

describe("JournaledFileOperationEngine", () => {
  it("先改写相对链接再移动文档", async () => {
    await writeFile(join(vaultRoot, "React.md"), "# React\n", "utf8");
    const fiberBody = "见 [React](React.md)\n";
    await writeFile(join(vaultRoot, "Fiber.md"), fiberBody, "utf8");
    await mkdir(join(vaultRoot, "notes"));
    const fiberToken = sha256Token(Buffer.from(fiberBody, "utf8"));

    const plan: FileOperationPlan = {
      operationId: "op_test_move",
      kind: "move-document",
      vaultId: "v-test",
      target: {
        fromRelativePath: "Fiber.md",
        toRelativePath: "notes/Fiber.md",
      },
      pathMoves: [
        {
          noteKey: "path:Fiber.md",
          kind: "document",
          fromRelativePath: "Fiber.md",
          toRelativePath: "notes/Fiber.md",
        },
      ],
      patches: [
        {
          sourcePageId: "path:Fiber.md",
          sourceRelativePathBefore: "Fiber.md",
          sourceRelativePathAfter: "notes/Fiber.md",
          expectedVersionToken: fiberToken,
          rules: [{ kind: "internal", oldHref: "React.md", newHref: "../React.md" }],
        },
      ],
      summary: {
        movedDocuments: 1,
        rewrittenDocuments: 1,
        rewrittenLinks: 1,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    };

    const result = await executeFileOperationPlan({ vaultRoot, plan });
    expect(result.pathMoves[0]?.toRelativePath).toBe("notes/Fiber.md");
    const moved = await readFile(join(vaultRoot, "notes", "Fiber.md"), "utf8");
    expect(moved).toContain("[React](../React.md)");
    // 成功后 journal 清除。
    await expect(access(journalDir(vaultRoot, plan.operationId))).rejects.toThrow();
  });

  it("case-only rename（temp-hop）成功路径", async () => {
    await writeFile(join(vaultRoot, "Foo.md"), "# Foo\n", "utf8");
    const plan: FileOperationPlan = {
      operationId: "op_case_only",
      kind: "rename-document-file",
      vaultId: "v-test",
      target: { fromRelativePath: "Foo.md", toRelativePath: "foo.md" },
      pathMoves: [
        {
          noteKey: null,
          kind: "document",
          fromRelativePath: "Foo.md",
          toRelativePath: "foo.md",
        },
      ],
      patches: [],
      summary: {
        movedDocuments: 1,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    };
    await executeFileOperationPlan({ vaultRoot, plan });
    expect(await exactExists("foo.md")).toBe(true);
    expect(await exactExists("Foo.md")).toBe(false);
    await expect(
      access(journalDir(vaultRoot, "op_case_only")),
    ).rejects.toThrow();
  });

  it("versionToken 不匹配 → STALE_PLAN 且文件未改", async () => {
    await writeFile(join(vaultRoot, "a.md"), "x\n", "utf8");
    const plan: FileOperationPlan = {
      operationId: "op_stale",
      kind: "move-document",
      vaultId: "v-test",
      target: { fromRelativePath: "a.md", toRelativePath: "b.md" },
      pathMoves: [
        {
          noteKey: null,
          kind: "document",
          fromRelativePath: "a.md",
          toRelativePath: "b/a.md",
        },
      ],
      patches: [
        {
          sourcePageId: "x",
          sourceRelativePathBefore: "a.md",
          sourceRelativePathAfter: "b/a.md",
          expectedVersionToken: "sha256:deadbeef",
          rules: [],
        },
      ],
      summary: {
        movedDocuments: 1,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    };
    await expect(executeFileOperationPlan({ vaultRoot, plan })).rejects.toMatchObject({
      code: "FILE_OPERATION_STALE_PLAN",
    });
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("x\n");
  });
});

/** 写一份 v2 journal 夹具（manifest + backup 文件）。 */
async function writeJournalFixture(input: {
  operationId: string;
  kind?: FileOperationJournal["kind"];
  phase: FileOperationJournalPhase;
  pathSteps: JournalPathStep[];
  backups?: Array<{
    originalRelativePath: string;
    backupRelativePath: string;
    versionToken: string;
    content: string;
  }>;
}) {
  const dir = journalDir(vaultRoot, input.operationId);
  await mkdir(dir, { recursive: true });
  for (const backup of input.backups ?? []) {
    const dest = join(dir, backup.backupRelativePath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, backup.content, "utf8");
  }
  const manifest: FileOperationJournal = {
    version: 2,
    operationId: input.operationId,
    vaultId: "v-test",
    kind: input.kind ?? "rename-document-file",
    phase: input.phase,
    backups: (input.backups ?? []).map(({ content: _content, ...rest }) => rest),
    pathSteps: input.pathSteps,
    createdAt: "2026-09-07T00:00:00.000Z",
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
}

async function readManifest(
  operationId: string,
): Promise<FileOperationJournal> {
  const raw = await readFile(
    join(journalDir(vaultRoot, operationId), "manifest.json"),
    "utf8",
  );
  return JSON.parse(raw) as FileOperationJournal;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(join(vaultRoot, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

/** 按父目录条目名精确判定（APFS 大小写不敏感，case-only 判定用）。 */
async function exactExists(rel: string): Promise<boolean> {
  const abs = join(vaultRoot, ...rel.split("/"));
  try {
    const entries = await readdir(dirname(abs));
    return entries.includes(basename(abs));
  } catch {
    return false;
  }
}

function docStep(
  id: string,
  fromRelativePath: string,
  toRelativePath: string,
  state: JournalPathStep["state"],
  extra?: Partial<JournalPathStep>,
): JournalPathStep {
  return {
    id,
    kind: "document",
    fromRelativePath,
    toRelativePath,
    hopRelativePath: null,
    state,
    ...extra,
  };
}

const CASE_HOP = (op: string) => `.e1/operations/${op}/tmp-hop-foo.md`;

describe("crash recovery：普通 rename 四象限（R11C-01）", () => {
  it("from 存在 + to 缺失（rename 未发生）→ 无需回迁，backup 还原，journal 清除", async () => {
    await writeFile(join(vaultRoot, "a.md"), "被污染\n", "utf8");
    await writeJournalFixture({
      operationId: "op-q1",
      phase: "relocating",
      pathSteps: [docStep("step-0", "a.md", "b.md", "intent")],
      backups: [
        {
          originalRelativePath: "a.md",
          backupRelativePath: "backup/h/a.md",
          versionToken: "sha256:t",
          content: "原文\n",
        },
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result).toMatchObject({
      recovered: true,
      rolledBackOperationIds: ["op-q1"],
      manualRequired: false,
    });
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("原文\n");
    expect(await exists("b.md")).toBe(false);
    expect(await exists(".e1/operations/op-q1")).toBe(false);
  });

  it("from 缺失 + to 存在（rename 已发生）→ 回迁 to→from", async () => {
    await writeFile(join(vaultRoot, "b.md"), "已改名\n", "utf8");
    await writeJournalFixture({
      operationId: "op-q2",
      phase: "relocating",
      pathSteps: [docStep("step-0", "a.md", "b.md", "applied")],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("已改名\n");
    expect(await exists("b.md")).toBe(false);
    expect(await exists(".e1/operations/op-q2")).toBe(false);
  });

  it("from/to 双存在 → recovery-required，journal 保留", async () => {
    await writeFile(join(vaultRoot, "a.md"), "A\n", "utf8");
    await writeFile(join(vaultRoot, "b.md"), "B\n", "utf8");
    await writeJournalFixture({
      operationId: "op-q3",
      phase: "relocating",
      pathSteps: [docStep("step-0", "a.md", "b.md", "applied")],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    expect(result.recovered).toBe(false);
    const manifest = await readManifest("op-q3");
    expect(manifest.phase).toBe("recovery-required");
    expect(manifest.pathSteps[0]?.state).toBe("recovery-required");
    // 无法安全判定：两个文件都不得被动过。
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("A\n");
    expect(await readFile(join(vaultRoot, "b.md"), "utf8")).toBe("B\n");
  });

  it("from/to 双缺失 → recovery-required，journal 保留", async () => {
    await writeJournalFixture({
      operationId: "op-q4",
      phase: "relocating",
      pathSteps: [docStep("step-0", "a.md", "b.md", "applied")],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    const manifest = await readManifest("op-q4");
    expect(manifest.phase).toBe("recovery-required");
  });
});

describe("crash recovery：group 多 step 逐条回迁", () => {
  it("group 操作的全部文档级 move 按逆序回迁", async () => {
    await mkdir(join(vaultRoot, "新"), { recursive: true });
    await writeFile(join(vaultRoot, "新", "x.md"), "X\n", "utf8");
    await writeFile(join(vaultRoot, "新", "y.md"), "Y\n", "utf8");
    await writeJournalFixture({
      operationId: "op-group",
      kind: "move-group",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "旧/x.md", "新/x.md", "applied"),
        docStep("step-1", "旧/y.md", "新/y.md", "applied"),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await readFile(join(vaultRoot, "旧", "x.md"), "utf8")).toBe("X\n");
    expect(await readFile(join(vaultRoot, "旧", "y.md"), "utf8")).toBe("Y\n");
    expect(await exists("新/x.md")).toBe(false);
    expect(await exists(".e1/operations/op-group")).toBe(false);
  });
});

describe("case-only temp-hop 逐跳恢复（R11C-02）", () => {
  it("crash before first rename（to-hop-intent 已落盘，rename 未发生）→ 保持原状", async () => {
    await writeFile(join(vaultRoot, "Foo.md"), "原文\n", "utf8");
    await writeJournalFixture({
      operationId: "op-c1",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "Foo.md", "foo.md", "intent", {
          hopRelativePath: CASE_HOP("op-c1"),
          hopState: "to-hop-intent",
        }),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await exactExists("Foo.md")).toBe(true);
    expect(await exactExists("foo.md")).toBe(false);
    expect(await exists(".e1/operations/op-c1")).toBe(false);
  });

  it("crash after first rename（at-hop，数据停在中转跳）→ hop 回 from", async () => {
    const hop = CASE_HOP("op-c2");
    await mkdir(join(vaultRoot, ".e1", "operations", "op-c2"), {
      recursive: true,
    });
    await writeFile(join(vaultRoot, "Foo.md"), "原文\n", "utf8");
    await fsRename(
      join(vaultRoot, "Foo.md"),
      join(vaultRoot, ...hop.split("/")),
    );
    await writeJournalFixture({
      operationId: "op-c2",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "Foo.md", "foo.md", "intent", {
          hopRelativePath: hop,
          hopState: "at-hop",
        }),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await exactExists("Foo.md")).toBe(true);
    expect(await readFile(join(vaultRoot, "Foo.md"), "utf8")).toBe("原文\n");
    expect(await exists(hop)).toBe(false);
  });

  it("crash before second rename（to-target-intent，hop 仍在）→ hop 回 from", async () => {
    // 与「second rename fails」同一 fs/journal 状态：第二跳未完成的全部
    // 情形都落在 hopState=to-target-intent + hop 存在（execute 失败路径与
    // crash 恢复共用 rollbackPathStep）。
    const hop = CASE_HOP("op-c3");
    await mkdir(join(vaultRoot, ".e1", "operations", "op-c3"), {
      recursive: true,
    });
    await writeFile(join(vaultRoot, "Foo.md"), "原文\n", "utf8");
    await fsRename(
      join(vaultRoot, "Foo.md"),
      join(vaultRoot, ...hop.split("/")),
    );
    await writeJournalFixture({
      operationId: "op-c3",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "Foo.md", "foo.md", "intent", {
          hopRelativePath: hop,
          hopState: "to-target-intent",
        }),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await exactExists("Foo.md")).toBe(true);
    expect(await exists(hop)).toBe(false);
  });

  it("crash after second rename（at-target/applied，目标已是新名）→ to 回 from", async () => {
    await writeFile(join(vaultRoot, "foo.md"), "原文\n", "utf8");
    await writeJournalFixture({
      operationId: "op-c4",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "Foo.md", "foo.md", "applied", {
          hopRelativePath: CASE_HOP("op-c4"),
          hopState: "at-target",
        }),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    expect(await exactExists("Foo.md")).toBe(true);
    expect(await exactExists("foo.md")).toBe(false);
    expect(await readFile(join(vaultRoot, "Foo.md"), "utf8")).toBe("原文\n");
  });

  it("rollback while at hop fails（hop 与 from 同时存在）→ recovery-required，hop 保留", async () => {
    const hop = CASE_HOP("op-c5");
    await mkdir(join(vaultRoot, ".e1", "operations", "op-c5"), {
      recursive: true,
    });
    await writeFile(join(vaultRoot, "Foo.md"), "原文\n", "utf8");
    await fsRename(
      join(vaultRoot, "Foo.md"),
      join(vaultRoot, ...hop.split("/")),
    );
    // 外部干预：from 路径上出现了新文件，无法安全判定。
    await writeFile(join(vaultRoot, "Foo.md"), "外部新建\n", "utf8");
    await writeJournalFixture({
      operationId: "op-c5",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "Foo.md", "foo.md", "intent", {
          hopRelativePath: hop,
          hopState: "at-hop",
        }),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    const manifest = await readManifest("op-c5");
    expect(manifest.phase).toBe("recovery-required");
    // hop 与 from 都不得被动过。
    expect(await readFile(join(vaultRoot, ...hop.split("/")), "utf8")).toBe(
      "原文\n",
    );
    expect(await readFile(join(vaultRoot, "Foo.md"), "utf8")).toBe("外部新建\n");
  });
});

describe("commit 窗口与 partial rollback（R11C-04）", () => {
  it("rename 后、journal 置 committed 前 crash → 可恢复", async () => {
    await writeFile(join(vaultRoot, "b.md"), "改写后\n", "utf8");
    await writeJournalFixture({
      operationId: "op-commit-window",
      phase: "relocating",
      pathSteps: [docStep("step-0", "a.md", "b.md", "applied")],
      backups: [
        {
          originalRelativePath: "a.md",
          backupRelativePath: "backup/h/a.md",
          versionToken: "sha256:t",
          content: "原文\n",
        },
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.recovered).toBe(true);
    // 先路径回迁（b→a），再从 backup 还原原文。
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("原文\n");
    expect(await exists("b.md")).toBe(false);
    expect(await exists(".e1/operations/op-commit-window")).toBe(false);
  });

  it("partial rollback：一个回迁失败 → journal 保留、phase=recovery-required，已成功的 step 不回撤", async () => {
    // step-0 可正常回迁；step-1 双存在无法判定。
    await writeFile(join(vaultRoot, "b.md"), "B\n", "utf8");
    await writeFile(join(vaultRoot, "c.md"), "C\n", "utf8");
    await writeFile(join(vaultRoot, "d.md"), "D\n", "utf8");
    await writeJournalFixture({
      operationId: "op-partial",
      phase: "relocating",
      pathSteps: [
        docStep("step-0", "a.md", "b.md", "applied"),
        docStep("step-1", "c.md", "d.md", "applied"),
      ],
    });

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    // journal 保留且进入 recovery-required。
    const manifest = await readManifest("op-partial");
    expect(manifest.phase).toBe("recovery-required");
    expect(manifest.pathSteps.find((s) => s.id === "step-0")?.state).toBe(
      "rolled-back",
    );
    expect(manifest.pathSteps.find((s) => s.id === "step-1")?.state).toBe(
      "recovery-required",
    );
    // step-0 已回迁；step-1 两文件保持原样。
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("B\n");
    expect(await readFile(join(vaultRoot, "c.md"), "utf8")).toBe("C\n");
    expect(await readFile(join(vaultRoot, "d.md"), "utf8")).toBe("D\n");
  });
});

describe("不可判定 journal 不静默跳过（R11C-03）", () => {
  it("corrupt journal → manualRequired", async () => {
    const dir = journalDir(vaultRoot, "op-corrupt");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), "{ 不是 JSON", "utf8");
    await writeFile(join(vaultRoot, "a.md"), "原文\n", "utf8");

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    expect(result.message).toMatch(/损坏|不兼容/);
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("原文\n");
  });

  it("version:1 journal → unsupported-version → manualRequired", async () => {
    const dir = journalDir(vaultRoot, "op-v1");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        operationId: "op-v1",
        vaultId: "v-test",
        kind: "rename-document-file",
        phase: "rewriting",
        fromRelativePath: "a.md",
        toRelativePath: "b.md",
        backups: [],
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
      "utf8",
    );

    const result = await recoverPendingFileOperations({ vaultRoot });
    expect(result.manualRequired).toBe(true);
    expect(await exists(".e1/operations/op-v1")).toBe(true);
  });

  it("存在 pending journal 时 execute 被拒绝（阻止危险写操作）", async () => {
    await writeFile(join(vaultRoot, "a.md"), "A\n", "utf8");
    await writeJournalFixture({
      operationId: "op-pending",
      phase: "prepared",
      pathSteps: [],
    });
    const plan: FileOperationPlan = {
      operationId: "op-blocked",
      kind: "rename-document-file",
      vaultId: "v-test",
      target: { fromRelativePath: "a.md", toRelativePath: "b.md" },
      pathMoves: [
        {
          noteKey: null,
          kind: "document",
          fromRelativePath: "a.md",
          toRelativePath: "b.md",
        },
      ],
      patches: [],
      summary: {
        movedDocuments: 1,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    };

    await expect(
      executeFileOperationPlan({ vaultRoot, plan }),
    ).rejects.toMatchObject({ code: "FILE_OPERATION_RECOVERY_REQUIRED" });
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("A\n");
    expect(await exists("b.md")).toBe(false);
    // 旧 journal 不被新操作破坏。
    expect(await exists(".e1/operations/op-pending")).toBe(true);
  });
});
