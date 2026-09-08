/**
 * R012 Stage 4（需求 §23/§39）：RevisionRestoreCoordinator 编排测试——
 * get 目标 → port.validate → before-restore 快照 → port.restore 的顺序与
 * 失败语义（校验失败不留快照；port 失败后保留 before-restore 安全快照）。
 */
import { describe, expect, it, vi } from "vitest";
import type { RevisionRepository } from "../../domain/repositories";
import type { DocumentRevision, RevisionSummary } from "../../domain/types";
import {
  JsonRevisionRestorePort,
  RevisionRestoreCoordinator,
  type RevisionRestorePort,
} from "./RevisionRestoreCoordinator";

const PAGE_ID = "p1";
const CURRENT = {
  contentJson: { type: "doc", content: [] },
  textSnapshot: "当前",
};
const TARGET: DocumentRevision = {
  id: "r1",
  pageId: PAGE_ID,
  contentJson: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "历史" }] }],
  },
  textSnapshot: "历史",
  createdAt: 1000,
  reason: "interval",
};

function fakeRevisions(
  overrides: Partial<RevisionRepository> = {},
): RevisionRepository & { added: { reason: string }[] } {
  const added: { reason: string }[] = [];
  return {
    added,
    listByPage: vi.fn(async () => [] as RevisionSummary[]),
    get: vi.fn(async () => TARGET as DocumentRevision | undefined),
    add: vi.fn(async (_p, _c, _t, reason) => {
      added.push({ reason });
      return null;
    }),
    pruneInterval: vi.fn(async () => undefined),
    ...overrides,
  };
}

const NOOP_COMMIT = vi.fn(async () => undefined);

describe("RevisionRestoreCoordinator", () => {
  it("目标版本不存在 → REVISION_NOT_FOUND，不调用 port", async () => {
    const revisions = fakeRevisions({
      get: vi.fn(async () => undefined),
    });
    const port: RevisionRestorePort = { restore: vi.fn() };
    const coordinator = new RevisionRestoreCoordinator({ revisions, port });
    await expect(
      coordinator.restoreRevision({
        pageId: PAGE_ID,
        revisionId: "missing",
        current: CURRENT,
        commit: NOOP_COMMIT,
      }),
    ).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    expect(port.restore).not.toHaveBeenCalled();
    expect(revisions.added).toHaveLength(0);
  });

  it("先落 before-restore（当前内容），再调 port.restore", async () => {
    const order: string[] = [];
    const revisions = fakeRevisions({
      add: vi.fn(async (_p, _c, _t, reason) => {
        order.push(`add:${reason}`);
        return null;
      }),
    });
    const port: RevisionRestorePort = {
      restore: vi.fn(async () => {
        order.push("port");
        return { reloadedExternally: false };
      }),
    };
    const coordinator = new RevisionRestoreCoordinator({ revisions, port });
    const outcome = await coordinator.restoreRevision({
      pageId: PAGE_ID,
      revisionId: "r1",
      current: CURRENT,
      commit: NOOP_COMMIT,
    });
    expect(order).toEqual(["add:before-restore", "port"]);
    expect(outcome).toEqual({ reloadedExternally: false });
  });

  it("port 失败 → 错误传播，before-restore 安全快照保留（§23）", async () => {
    const revisions = fakeRevisions();
    const port: RevisionRestorePort = {
      restore: vi.fn(async () => {
        throw new Error("io");
      }),
    };
    const coordinator = new RevisionRestoreCoordinator({ revisions, port });
    await expect(
      coordinator.restoreRevision({
        pageId: PAGE_ID,
        revisionId: "r1",
        current: CURRENT,
        commit: NOOP_COMMIT,
      }),
    ).rejects.toThrow("io");
    expect(revisions.added).toEqual([{ reason: "before-restore" }]);
  });
});

describe("JsonRevisionRestorePort（Web/内存）", () => {
  it("损坏 contentJson → CORRUPTED_DOCUMENT，且协调器不产生 before-restore", async () => {
    const revisions = fakeRevisions({
      get: vi.fn(async () => ({
        ...TARGET,
        contentJson: { type: "doc", content: [{ type: "evilNode" }] },
      })),
    });
    const coordinator = new RevisionRestoreCoordinator({
      revisions,
      port: new JsonRevisionRestorePort(),
    });
    await expect(
      coordinator.restoreRevision({
        pageId: PAGE_ID,
        revisionId: "r1",
        current: CURRENT,
        commit: NOOP_COMMIT,
      }),
    ).rejects.toMatchObject({ code: "CORRUPTED_DOCUMENT" });
    expect(revisions.added).toHaveLength(0);
    expect(NOOP_COMMIT).not.toHaveBeenCalled();
  });

  it("合法版本：经 commit 闭包提交解析后的 contentJson", async () => {
    const revisions = fakeRevisions();
    const commit = vi.fn(async () => undefined);
    const coordinator = new RevisionRestoreCoordinator({
      revisions,
      port: new JsonRevisionRestorePort(),
    });
    const outcome = await coordinator.restoreRevision({
      pageId: PAGE_ID,
      revisionId: "r1",
      current: CURRENT,
      commit,
    });
    expect(commit).toHaveBeenCalledWith(TARGET.contentJson, "历史");
    expect(outcome.reloadedExternally).toBe(false);
    expect(revisions.added).toEqual([{ reason: "before-restore" }]);
  });
});

describe("RevisionRestoreCoordinator.diffWithCurrent（R012 Stage 5，需求 §27）", () => {
  it("目标版本不存在 → null", async () => {
    const revisions = fakeRevisions({ get: vi.fn(async () => undefined) });
    const coordinator = new RevisionRestoreCoordinator({
      revisions,
      port: { restore: vi.fn() },
    });
    expect(
      await coordinator.diffWithCurrent({
        pageId: PAGE_ID,
        revisionId: "missing",
        currentTextSnapshot: "当前",
      }),
    ).toBeNull();
  });

  it("port 无 readCurrentSource → current 回退 currentTextSnapshot", async () => {
    const coordinator = new RevisionRestoreCoordinator({
      revisions: fakeRevisions(),
      port: { restore: vi.fn() },
    });
    expect(
      await coordinator.diffWithCurrent({
        pageId: PAGE_ID,
        revisionId: "r1",
        currentTextSnapshot: "编辑器当前文本",
      }),
    ).toEqual({ historical: "历史", current: "编辑器当前文本" });
  });

  it("port 有 readCurrentSource → current 用平台对比源（Desktop 磁盘 raw body）", async () => {
    const readCurrentSource = vi.fn(async () => "磁盘当前 raw body");
    const coordinator = new RevisionRestoreCoordinator({
      revisions: fakeRevisions(),
      port: { restore: vi.fn(), readCurrentSource },
    });
    expect(
      await coordinator.diffWithCurrent({
        pageId: PAGE_ID,
        revisionId: "r1",
        currentTextSnapshot: "编辑器当前文本",
      }),
    ).toEqual({ historical: "历史", current: "磁盘当前 raw body" });
    expect(readCurrentSource).toHaveBeenCalledWith(PAGE_ID);
  });

  it("readCurrentSource 返回 null → 回退 currentTextSnapshot", async () => {
    const coordinator = new RevisionRestoreCoordinator({
      revisions: fakeRevisions(),
      port: { restore: vi.fn(), readCurrentSource: vi.fn(async () => null) },
    });
    expect(
      await coordinator.diffWithCurrent({
        pageId: PAGE_ID,
        revisionId: "r1",
        currentTextSnapshot: "编辑器当前文本",
      }),
    ).toEqual({ historical: "历史", current: "编辑器当前文本" });
  });
});
