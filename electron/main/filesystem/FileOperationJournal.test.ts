// @vitest-environment node
/**
 * R011.1（R11C-03/05）：FileOperationJournal v2——读取显式分类、
 * corrupt/旧版本不静默跳过、backup 哈希命名防碰撞。
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertJournalCompatible,
  backupFile,
  createJournal,
  journalDir,
  listPendingJournals,
  readJournal,
} from "./FileOperationJournal.js";
import type { JournalPathStep } from "../../../shared/fileOperations/journal.js";

let vaultRoot: string;

const STEP: JournalPathStep = {
  id: "step-0",
  kind: "document",
  fromRelativePath: "a.md",
  toRelativePath: "b.md",
  hopRelativePath: null,
  state: "pending",
};

async function writeManifest(operationId: string, manifest: unknown) {
  const dir = journalDir(vaultRoot, operationId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    "utf8",
  );
}

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-journal-io-"));
});

describe("readJournal 显式分类", () => {
  it("不存在 → missing", async () => {
    const result = await readJournal(vaultRoot, "op-absent");
    expect(result.kind).toBe("missing");
  });

  it("非法 JSON → corrupt（不静默）", async () => {
    await writeManifest("op-corrupt", "{ not json");
    const result = await readJournal(vaultRoot, "op-corrupt");
    expect(result.kind).toBe("corrupt");
  });

  it("v1 journal → unsupported-version（不迁移）", async () => {
    await writeManifest("op-v1", {
      version: 1,
      operationId: "op-v1",
      vaultId: "v-test",
      kind: "move-document",
      phase: "rewriting",
      fromRelativePath: "a.md",
      toRelativePath: "b.md",
      backups: [],
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    const result = await readJournal(vaultRoot, "op-v1");
    expect(result).toEqual({ kind: "unsupported-version", version: 1 });
  });

  it("缺 version / 形状不符 → corrupt", async () => {
    await writeManifest("op-shape", { operationId: "op-shape" });
    const result = await readJournal(vaultRoot, "op-shape");
    expect(result.kind).toBe("corrupt");
  });

  it("v2 正常形态 → ok", async () => {
    await createJournal({
      vaultRoot,
      operationId: "op-ok",
      vaultId: "v-test",
      kind: "move-document",
      pathSteps: [STEP],
    });
    const result = await readJournal(vaultRoot, "op-ok");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.journal.version).toBe(2);
    expect(result.journal.pathSteps).toHaveLength(1);
  });
});

describe("listPendingJournals", () => {
  it("corrupt / unsupported-version 进入 unreadable，不静默跳过", async () => {
    await createJournal({
      vaultRoot,
      operationId: "op-pending",
      vaultId: "v-test",
      kind: "move-document",
      pathSteps: [STEP],
    });
    await writeManifest("op-corrupt", "!!{");
    await writeManifest("op-v1", { version: 1, operationId: "op-v1" });
    const scan = await listPendingJournals(vaultRoot);
    expect(scan.pending.map((j) => j.operationId)).toEqual(["op-pending"]);
    expect(scan.unreadable.map((u) => u.operationId).sort()).toEqual([
      "op-corrupt",
      "op-v1",
    ]);
  });

  it("operations 目录不存在 → 空结果", async () => {
    const scan = await listPendingJournals(vaultRoot);
    expect(scan).toEqual({ pending: [], unreadable: [] });
  });
});

describe("backupFile 命名（R11C-05）", () => {
  it("a/b.md 与 a__b.md 同操作不碰撞", async () => {
    await mkdir(join(vaultRoot, "a"), { recursive: true });
    await writeFile(join(vaultRoot, "a", "b.md"), "nested\n", "utf8");
    await writeFile(join(vaultRoot, "a__b.md"), "flat\n", "utf8");

    const first = await backupFile({
      vaultRoot,
      operationId: "op-bak",
      originalRelativePath: "a/b.md",
      versionToken: "sha256:x",
    });
    const second = await backupFile({
      vaultRoot,
      operationId: "op-bak",
      originalRelativePath: "a__b.md",
      versionToken: "sha256:y",
    });

    expect(first.backupRelativePath).not.toBe(second.backupRelativePath);
    // 形状：backup/<sha256(relativePath)前16位>/<basename>
    expect(first.backupRelativePath).toMatch(/^backup\/[0-9a-f]{16}\/b\.md$/);
    expect(second.backupRelativePath).toMatch(/^backup\/[0-9a-f]{16}\/a__b\.md$/);
    const dir = journalDir(vaultRoot, "op-bak");
    await expect(
      readFile(join(dir, first.backupRelativePath), "utf8"),
    ).resolves.toBe("nested\n");
    await expect(
      readFile(join(dir, second.backupRelativePath), "utf8"),
    ).resolves.toBe("flat\n");
  });
});

describe("assertJournalCompatible", () => {
  it("ok 通过；missing/corrupt/unsupported-version 抛 RECOVERY_REQUIRED", async () => {
    await createJournal({
      vaultRoot,
      operationId: "op-ok",
      vaultId: "v-test",
      kind: "move-document",
      pathSteps: [STEP],
    });
    const ok = await readJournal(vaultRoot, "op-ok");
    expect(() => assertJournalCompatible(ok)).not.toThrow();

    const missing = await readJournal(vaultRoot, "op-absent");
    try {
      assertJournalCompatible(missing);
      expect.unreachable("missing 应抛错");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        "FILE_OPERATION_RECOVERY_REQUIRED",
      );
    }

    await writeManifest("op-v1", { version: 1 });
    const old = await readJournal(vaultRoot, "op-v1");
    try {
      assertJournalCompatible(old);
      expect.unreachable("unsupported-version 应抛错");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        "FILE_OPERATION_RECOVERY_REQUIRED",
      );
    }
  });
});
