/**
 * DocumentSaveCoordinator 单元测试（R003 §1.1 核心规则）：
 * 串行执行、latest-wins、旧代次不发布 saved、附件清理只在最新快照、
 * 失败重试、flush 语义、恢复缓冲写入/清除。
 * 仓储全部用内存 stub，不依赖 IndexedDB。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, isDomainError } from "../../domain/errors";
import type { RevisionRepository } from "../../domain/repositories";
import type { RevisionReason, RevisionSummary } from "../../domain/types";
import {
  INTERVAL_REVISION_KEEP,
  INTERVAL_REVISION_MAX_BYTES,
  INTERVAL_REVISION_MS,
} from "../../domain/revisions";
import { createDeferred, sleep, type Deferred } from "../../test/fixtures";
import type { DocumentContentCommitter } from "./DocumentCommitService";
import {
  DocumentSaveCoordinator,
  type SaveCoordinatorState,
} from "./SaveCoordinator";
import type { RecoveryRecord } from "./RecoveryStore";

function makeStubs() {
  const saves: { pageId: string; json: unknown; text: string }[] = [];
  const saveGates: Deferred<void>[] = [];
  const orphanCalls: string[][] = [];
  const revisionAdds: string[] = [];
  const recoveryWrites: RecoveryRecord[] = [];
  const recoveryClears: { pageId: string; savedGeneration: number }[] = [];

  const committer: DocumentContentCommitter = {
    async commit(pageId, json, text, expectedVersion) {
      saves.push({ pageId, json, text });
      // 每次保存自动挂起，由测试按序放行，精确控制完成时机。
      const gate = createDeferred<void>();
      saveGates.push(gate);
      await gate.promise;
      // R005 阶段 3：版本为不透明令牌，stub 只保证每次返回不同的新令牌。
      return { savedAt: Date.now(), version: `${expectedVersion}+` };
    },
  };
  const revisions: RevisionRepository = {
    async listByPage() {
      return [];
    },
    async get() {
      return undefined;
    },
    async add(_pageId, _json, text): Promise<RevisionSummary | null> {
      revisionAdds.push(text);
      return null; // 不创建版本，避免干扰断言；节流逻辑由集成测试覆盖。
    },
    async pruneInterval() {},
  };
  // R005 阶段 5：协调器只需要孤儿清理能力（Pick<AssetStore, "removeOrphans">）。
  const assets = {
    async removeOrphans(_pageId: string, referencedIds: string[]) {
      orphanCalls.push(referencedIds);
      return 0;
    },
  };
  const recovery = {
    write(record: RecoveryRecord) {
      recoveryWrites.push(record);
    },
    clear(pageId: string, savedGeneration: number) {
      recoveryClears.push({ pageId, savedGeneration });
    },
  };
  return {
    committer,
    revisions,
    assets,
    recovery,
    saves,
    saveGates,
    orphanCalls,
    revisionAdds,
    recoveryWrites,
    recoveryClears,
  };
}

const DOC = { type: "doc", content: [{ type: "paragraph" }] };

describe("DocumentSaveCoordinator", () => {
  let stubs: ReturnType<typeof makeStubs>;
  let states: SaveCoordinatorState[];
  let coordinator: DocumentSaveCoordinator;

  beforeEach(() => {
    stubs = makeStubs();
    states = [];
    coordinator = new DocumentSaveCoordinator("page-1", {
      committer: stubs.committer,
      revisions: stubs.revisions,
      assets: stubs.assets,
      recovery: stubs.recovery,
      onStateChange: (s) => states.push(s),
    });
  });

  it("编辑递增代次并发布 dirty", () => {
    coordinator.noteEdit();
    coordinator.noteEdit();
    expect(states.map((s) => s.status)).toEqual(["dirty", "dirty"]);
  });

  it("保存串行执行，乱序完成时最终落盘为最新快照", async () => {
    coordinator.noteEdit();
    const first = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "旧内容",
    });
    // 第一个保存在途（门控挂起），提交第二个快照。
    await Promise.resolve();
    expect(stubs.saves).toHaveLength(1);

    coordinator.noteEdit();
    const second = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "新内容",
    });
    expect(stubs.saves).toHaveLength(1); // 串行：第二个保存尚未发起

    stubs.saveGates[0].resolve();
    await first;
    // 第一个保存完成后，串行队列才发起第二个保存。
    await vi.waitFor(() => expect(stubs.saves).toHaveLength(2));
    expect(stubs.saves[1].text).toBe("新内容");

    stubs.saveGates[1].resolve();
    const result = await second;
    expect(result.generation).toBe(2);
    // enqueue Promise 在正文提交后兑现；维护效果（附件清理）待队列排空后断言。
    await coordinator.flush();
    // 附件清理只在最新快照执行一次。
    expect(stubs.orphanCalls).toHaveLength(1);
    expect(coordinator.getState().status).toBe("saved");
  });

  it("旧代次保存完成时不发布 saved", async () => {
    coordinator.noteEdit();
    const first = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "旧内容",
    });
    await Promise.resolve();

    // 新编辑仅 noteEdit（防抖未入队）时，旧保存完成。
    coordinator.noteEdit();
    stubs.saveGates[0].resolve();
    await first;

    expect(coordinator.getState().status).not.toBe("saved");
  });

  it("保存失败进入 error，retryLatest 重试最新内容", async () => {
    coordinator.noteEdit();
    const failing = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容",
    });
    await Promise.resolve();
    const err = new Error("写入失败");
    stubs.saveGates[0].reject(err);
    await expect(failing).rejects.toThrow("写入失败");
    expect(coordinator.getState().status).toBe("error");

    const retry = coordinator.retryLatest();
    await Promise.resolve();
    expect(stubs.saves).toHaveLength(2);
    expect(stubs.saves[1].text).toBe("内容");
    stubs.saveGates[1].resolve();
    await retry;
    await coordinator.flush();
    expect(coordinator.getState().status).toBe("saved");
  });

  it("配额耗尽失败分类为 quota，普通失败为 generic（R004 阶段 6）", async () => {
    // QuotaExceededError → errorKind "quota"（UI 提示「本地存储空间不足」）。
    coordinator.noteEdit();
    const quotaFailing = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容",
    });
    await Promise.resolve();
    stubs.saveGates[0].reject(new DOMException("full", "QuotaExceededError"));
    await expect(quotaFailing).rejects.toThrow();
    expect(coordinator.getState().status).toBe("error");
    expect(coordinator.getState().errorKind).toBe("quota");

    // 普通写入失败 → errorKind "generic"。
    const genericFailing = coordinator.retryLatest();
    await Promise.resolve();
    stubs.saveGates[1].reject(new Error("写入失败"));
    await expect(genericFailing).rejects.toThrow("写入失败");
    expect(coordinator.getState().errorKind).toBe("generic");

    // 恢复成功后 errorKind 复位。
    const retry = coordinator.retryLatest();
    await Promise.resolve();
    stubs.saveGates[2].resolve();
    await retry;
    await coordinator.flush();
    expect(coordinator.getState().status).toBe("saved");
    expect(coordinator.getState().errorKind).toBeNull();
  });

  it("flush 等待队列排空", async () => {
    coordinator.noteEdit();
    void coordinator.enqueue({ contentJson: DOC, textSnapshot: "内容" });
    await Promise.resolve();

    let flushed = false;
    void coordinator.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    stubs.saveGates[0].resolve();
    await coordinator.flush();
    await vi.waitFor(() => expect(flushed).toBe(true));
    expect(coordinator.hasPending()).toBe(false);
  });

  it("入队写恢复缓冲，最新快照保存成功后按代次清除", async () => {
    coordinator.noteEdit();
    const save = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容",
    });
    await Promise.resolve();
    expect(stubs.recoveryWrites).toHaveLength(1);
    expect(stubs.recoveryWrites[0].generation).toBe(1);

    stubs.saveGates[0].resolve();
    await save;
    await coordinator.flush();
    expect(stubs.recoveryClears).toEqual([
      { pageId: "page-1", savedGeneration: 1 },
    ]);
  });

  it("dispose 后排斥新的保存请求", async () => {
    await coordinator.dispose();
    await expect(
      coordinator.enqueue({ contentJson: DOC, textSnapshot: "内容" }),
    ).rejects.toThrow("已销毁");
  });
});

/**
 * R004 阶段 0 基线：保存后半程（正文落盘后、维护步骤执行中）的竞态。
 * 门控 revision.add / removeOrphans，在挂起窗口内继续编辑递增 generation，
 * 旧快照随后不得发布 saved、不得清除新编辑的恢复缓冲、不得按无时间边界的
 * 引用集清理附件；维护失败不得把已成功保存的正文误报为 error。
 */
describe("DocumentSaveCoordinator 保存后半程竞态（R004）", () => {
  interface PostCommitStubs {
    deps: ConstructorParameters<typeof DocumentSaveCoordinator>[1];
    saveGates: Deferred<void>[];
    revisionGates: Deferred<RevisionSummary | null>[];
    orphanGates: Deferred<number>[];
    orphanCalls: {
      referencedIds: string[];
      options?: { createdBeforeOrAt?: number };
    }[];
    recoveryWrites: RecoveryRecord[];
    recoveryClears: { pageId: string; savedGeneration: number }[];
    maintenanceErrors: { stage: string; error: unknown }[];
    failOrphans: { value: boolean };
  }

  function makePostCommitStubs(): PostCommitStubs {
    const saveGates: Deferred<void>[] = [];
    const revisionGates: Deferred<RevisionSummary | null>[] = [];
    const orphanGates: Deferred<number>[] = [];
    const orphanCalls: PostCommitStubs["orphanCalls"] = [];
    const recoveryWrites: RecoveryRecord[] = [];
    const recoveryClears: { pageId: string; savedGeneration: number }[] = [];
    const maintenanceErrors: { stage: string; error: unknown }[] = [];
    const failOrphans = { value: false };

    const committer: DocumentContentCommitter = {
      async commit(_pageId, _json, _text, expectedVersion) {
        const gate = createDeferred<void>();
        saveGates.push(gate);
        await gate.promise;
        // 不透明令牌：每次返回不同的新令牌（R005 阶段 3）。
        return { savedAt: Date.now(), version: `${expectedVersion}+` };
      },
    };
    const revisions: RevisionRepository = {
      async listByPage() {
        return [];
      },
      async get() {
        return undefined;
      },
      async add(): Promise<RevisionSummary | null> {
        const gate = createDeferred<RevisionSummary | null>();
        revisionGates.push(gate);
        return gate.promise;
      },
      async pruneInterval() {},
    };
    const assets = {
      async removeOrphans(
        _pageId: string,
        referencedIds: string[],
        options?: { createdBeforeOrAt?: number },
      ) {
        orphanCalls.push({ referencedIds, options });
        if (failOrphans.value) throw new Error("清理失败");
        const gate = createDeferred<number>();
        orphanGates.push(gate);
        return gate.promise;
      },
    };
    const deps: PostCommitStubs["deps"] = {
      committer,
      revisions,
      assets,
      recovery: {
        write(record) {
          recoveryWrites.push(record);
        },
        clear(pageId, savedGeneration) {
          recoveryClears.push({ pageId, savedGeneration });
        },
      },
      onMaintenanceError(stage, error) {
        maintenanceErrors.push({ stage, error });
      },
    };
    return {
      deps,
      saveGates,
      revisionGates,
      orphanGates,
      orphanCalls,
      recoveryWrites,
      recoveryClears,
      maintenanceErrors,
      failOrphans,
    };
  }

  function lastStatus(states: SaveCoordinatorState[]) {
    return states[states.length - 1]?.status;
  }

  it("revision.add 挂起期间继续编辑：旧快照不得发布 saved、不得清恢复缓冲", async () => {
    const stubs = makePostCommitStubs();
    const states: SaveCoordinatorState[] = [];
    const coordinator = new DocumentSaveCoordinator("page-1", {
      ...stubs.deps,
      onStateChange: (s) => states.push(s),
    });

    coordinator.noteEdit();
    const saveA = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容A",
    });
    await Promise.resolve();
    // 正文 A 落盘，revision.add 挂起。
    stubs.saveGates[0].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(1));

    // 挂起窗口内继续编辑 B：generation 递增、恢复缓冲写入 gen 2。
    coordinator.noteEdit();
    const saveB = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容B",
    });
    expect(stubs.recoveryWrites.at(-1)?.generation).toBe(2);

    // 放行 A 的后处理（未创建版本，保持 lastIntervalAt 为空，
    // 后续 B 保存仍会做 interval 检查）：A 已不是当前 generation。
    stubs.revisionGates[0].resolve(null);
    await vi.waitFor(() => expect(stubs.saveGates).toHaveLength(2));

    expect(states.filter((s) => s.status === "saved")).toHaveLength(0);
    expect(stubs.recoveryClears).toHaveLength(0);
    // A 的附件清理也不得执行（维护整段跳过）。
    expect(stubs.orphanCalls).toHaveLength(0);

    // B 保存完成后才允许发布 saved 并清除恢复缓冲。
    stubs.saveGates[1].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(2));
    stubs.revisionGates[1].resolve(null);
    await vi.waitFor(() => expect(stubs.orphanGates).toHaveLength(1));
    stubs.orphanGates[0].resolve(0);
    await saveB;
    await saveA;
    await coordinator.flush();
    expect(lastStatus(states)).toBe("saved");
    expect(stubs.recoveryClears).toEqual([
      { pageId: "page-1", savedGeneration: 2 },
    ]);
  });

  it("removeOrphans 挂起期间继续编辑：旧快照不得发布 saved、不得清恢复缓冲", async () => {
    const stubs = makePostCommitStubs();
    const states: SaveCoordinatorState[] = [];
    const coordinator = new DocumentSaveCoordinator("page-1", {
      ...stubs.deps,
      onStateChange: (s) => states.push(s),
    });

    coordinator.noteEdit();
    const saveA = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容A",
    });
    await Promise.resolve();
    stubs.saveGates[0].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(1));
    stubs.revisionGates[0].resolve(null);
    // 附件清理挂起。
    await vi.waitFor(() => expect(stubs.orphanGates).toHaveLength(1));

    coordinator.noteEdit();
    const saveB = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容B",
    });

    // 放行 A 的附件清理：A 已过期。
    stubs.orphanGates[0].resolve(0);
    await vi.waitFor(() => expect(stubs.saveGates).toHaveLength(2));

    expect(states.filter((s) => s.status === "saved")).toHaveLength(0);
    expect(stubs.recoveryClears).toHaveLength(0);

    stubs.saveGates[1].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(2));
    stubs.revisionGates[1].resolve(null);
    await vi.waitFor(() => expect(stubs.orphanGates).toHaveLength(2));
    stubs.orphanGates[1].resolve(0);
    await saveB;
    await saveA;
    await coordinator.flush();
    expect(lastStatus(states)).toBe("saved");
  });

  it("附件清理携带快照时间边界（INV-03）", async () => {
    const stubs = makePostCommitStubs();
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    const before = Date.now();
    coordinator.noteEdit();
    const save = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容",
    });
    await Promise.resolve();
    stubs.saveGates[0].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(1));
    stubs.revisionGates[0].resolve(null);
    await vi.waitFor(() => expect(stubs.orphanGates).toHaveLength(1));
    stubs.orphanGates[0].resolve(0);
    await save;

    expect(stubs.orphanCalls).toHaveLength(1);
    const capturedAt = stubs.orphanCalls[0].options?.createdBeforeOrAt;
    expect(typeof capturedAt).toBe("number");
    expect(capturedAt).toBeGreaterThanOrEqual(before);
    expect(capturedAt!).toBeLessThanOrEqual(Date.now());
  });

  it("附件清理失败：正文已保存不进入 error，经 onMaintenanceError 上报", async () => {
    const stubs = makePostCommitStubs();
    stubs.failOrphans.value = true;
    const states: SaveCoordinatorState[] = [];
    const coordinator = new DocumentSaveCoordinator("page-1", {
      ...stubs.deps,
      onStateChange: (s) => states.push(s),
    });

    coordinator.noteEdit();
    const save = coordinator.enqueue({
      contentJson: DOC,
      textSnapshot: "内容",
    });
    await Promise.resolve();
    stubs.saveGates[0].resolve();
    await vi.waitFor(() => expect(stubs.revisionGates).toHaveLength(1));
    stubs.revisionGates[0].resolve(null);

    // 正文提交成功，维护失败不应使保存 Promise 拒绝。
    await save;
    await coordinator.flush();
    expect(lastStatus(states)).toBe("saved");
    expect(stubs.maintenanceErrors).toHaveLength(1);
    expect(stubs.maintenanceErrors[0].stage).toBe("attachment-cleanup");
  });

  it("空状态调用 retryLatest 显式拒绝", async () => {
    const stubs = makePostCommitStubs();
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    const outcome = await Promise.race([
      coordinator.retryLatest().then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      sleep(50).then(() => ({ kind: "pending" as const })),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect((outcome.err as Error).message).toContain("没有可重试的保存");
    }
  });
});

/**
 * 乐观并发冲突（R004 阶段 7 §7.3）：
 * DOCUMENT_CONFLICT 进入 errorKind: "conflict"、不自动重试；
 * 「强制覆盖」经 setLoadedVersion(磁盘最新) + retryLatest 以正确
 * expectedVersion 重试成功；initialVersion 构造参数作为首次提交的起点。
 */
describe("DocumentSaveCoordinator 乐观并发冲突", () => {
  function makeConflictStubs(options?: { conflictTimes?: number }) {
    const commits: { expectedVersion: string; text: string }[] = [];
    let conflictLeft = options?.conflictTimes ?? Number.POSITIVE_INFINITY;
    const committer: DocumentContentCommitter = {
      async commit(_pageId, _json, text, expectedVersion) {
        commits.push({ expectedVersion, text });
        if (conflictLeft > 0) {
          conflictLeft -= 1;
          throw new DomainError("DOCUMENT_CONFLICT", "文档已在其他地方被修改");
        }
        // 不透明令牌：每次返回不同的新令牌（R005 阶段 3）。
        return { savedAt: Date.now(), version: `${expectedVersion}+` };
      },
    };
    const states: SaveCoordinatorState[] = [];
    const coordinator = new DocumentSaveCoordinator(
      "page-1",
      {
        committer,
        revisions: {
          async listByPage() {
            return [];
          },
          async get() {
            return undefined;
          },
          async add() {
            return null;
          },
          async pruneInterval() {},
        },
        assets: {
          async removeOrphans() {
            return 0;
          },
        },
        onStateChange: (s) => states.push(s),
      },
      // 不透明令牌（R005 阶段 3）：协调器不解析，原样作为首次 expectedVersion。
      { initialVersion: "t:3" },
    );
    return { commits, states, coordinator };
  }

  it("首次提交以 initialVersion 为 expectedVersion", async () => {
    const { commits, coordinator } = makeConflictStubs({ conflictTimes: 0 });
    coordinator.noteEdit();
    const save = coordinator.enqueue({ contentJson: DOC, textSnapshot: "新" });
    await save;
    expect(commits).toEqual([{ expectedVersion: "t:3", text: "新" }]);
    // 成功后回填提交方返回的新令牌。
    expect(coordinator.getLoadedVersion()).toBe("t:3+");
  });

  it("DOCUMENT_CONFLICT 进入 errorKind conflict，不自动重试", async () => {
    const { commits, states, coordinator } = makeConflictStubs();
    coordinator.noteEdit();
    const save = coordinator.enqueue({ contentJson: DOC, textSnapshot: "新" });
    await expect(save).rejects.toSatisfy((e) =>
      isDomainError(e, "DOCUMENT_CONFLICT"),
    );
    const last = states[states.length - 1];
    expect(last.status).toBe("error");
    expect(last.errorKind).toBe("conflict");
    // 不自动重试：等待一段时间后没有新的提交。
    await sleep(50);
    expect(commits).toHaveLength(1);
    await coordinator.dispose();
  });

  it("强制覆盖：setLoadedVersion(磁盘最新) 后 retryLatest 成功", async () => {
    const { commits, states, coordinator } = makeConflictStubs({
      conflictTimes: 1,
    });
    coordinator.noteEdit();
    await expect(
      coordinator.enqueue({ contentJson: DOC, textSnapshot: "本地内容" }),
    ).rejects.toSatisfy((e) => isDomainError(e, "DOCUMENT_CONFLICT"));

    // 模拟冲突 UI「强制覆盖」：读到磁盘最新令牌为 "t:8"，以之为 expectedVersion 重试。
    coordinator.setLoadedVersion("t:8");
    const result = await coordinator.retryLatest();
    expect(commits[1]).toEqual({ expectedVersion: "t:8", text: "本地内容" });
    expect(result.savedAt).toBeGreaterThan(0);
    expect(coordinator.getLoadedVersion()).toBe("t:8+");
    // saved 在维护段之后发布：等队列排空再断言最终状态。
    await coordinator.flush();
    expect(states[states.length - 1].status).toBe("saved");
  });
});


/**
 * R012 Stage 3（需求 §22/§34）：interval 自动版本捕获在保存维护链路中的
 * 行为锁定——首次保存即建、5 分钟节流、去重命中（add → null）仍执行
 * prune、capture 失败不污染正文保存状态（onMaintenanceError 降级）。
 * 用可控时钟（commit 返回的 savedAt）与可配置版本历史精确驱动门控。
 */
describe("DocumentSaveCoordinator interval 自动版本（R012 Stage 3）", () => {
  const T0 = 1_700_000_000_000;

  interface IntervalStubs {
    deps: ConstructorParameters<typeof DocumentSaveCoordinator>[1];
    adds: { pageId: string; text: string; reason: RevisionReason }[];
    prunes: { pageId: string; keep: number; maxBytes?: number }[];
    orphanCalls: string[];
    recoveryClears: string[];
    maintenanceErrors: { stage: string; error: unknown }[];
    /** 推进 commit 返回的 savedAt（保存时间）。 */
    setNow(next: number): void;
  }

  function makeSummary(createdAt: number, reason: RevisionReason): RevisionSummary {
    return {
      id: `r-${createdAt}-${reason}`,
      pageId: "page-1",
      createdAt,
      reason,
      bytes: 16,
      textPreview: "预览",
    };
  }

  function makeIntervalStubs(options?: {
    /** 构造时 listByPage 返回的历史（用于 lastIntervalAt 回填）。 */
    history?: RevisionSummary[];
    /** add 的返回值；缺省 null（去重命中）。 */
    addResult?: RevisionSummary | null;
    /** add 抛错（模拟 Desktop capture IPC 失败）。 */
    failAdd?: boolean;
  }): IntervalStubs {
    let now = T0;
    const adds: IntervalStubs["adds"] = [];
    const prunes: IntervalStubs["prunes"] = [];
    const orphanCalls: string[] = [];
    const recoveryClears: string[] = [];
    const maintenanceErrors: IntervalStubs["maintenanceErrors"] = [];

    const committer: DocumentContentCommitter = {
      async commit(_pageId, _json, _text, expectedVersion) {
        return { savedAt: now, version: `${expectedVersion}+` };
      },
    };
    const revisions: RevisionRepository = {
      async listByPage() {
        return options?.history ?? [];
      },
      async get() {
        return undefined;
      },
      async add(pageId, _json, text, reason) {
        adds.push({ pageId, text, reason });
        if (options?.failAdd) throw new Error("capture IPC 失败");
        return options?.addResult ?? null;
      },
      async pruneInterval(pageId, keep, maxBytes) {
        prunes.push({ pageId, keep, maxBytes });
      },
    };
    return {
      deps: {
        committer,
        revisions,
        assets: {
          async removeOrphans(pageId) {
            orphanCalls.push(pageId);
            return 0;
          },
        },
        recovery: {
          write() {},
          clear(pageId) {
            recoveryClears.push(pageId);
          },
        },
        onMaintenanceError(stage, error) {
          maintenanceErrors.push({ stage, error });
        },
      },
      adds,
      prunes,
      orphanCalls,
      recoveryClears,
      maintenanceErrors,
      setNow(next) {
        now = next;
      },
    };
  }

  /** 编辑并入队保存，等待队列排空（含维护段执行完毕）。 */
  async function saveOnce(
    coordinator: DocumentSaveCoordinator,
    text: string,
  ): Promise<void> {
    coordinator.noteEdit();
    const save = coordinator.enqueue({ contentJson: DOC, textSnapshot: text });
    await save;
    await coordinator.flush();
  }

  it("首次保存（无历史）创建 interval 快照，并按 100 个 / 5MiB 预算裁剪", async () => {
    const stubs = makeIntervalStubs({
      addResult: makeSummary(T0, "interval"),
    });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    await saveOnce(coordinator, "首版内容");

    expect(stubs.adds).toEqual([
      { pageId: "page-1", text: "首版内容", reason: "interval" },
    ]);
    expect(stubs.prunes).toEqual([
      {
        pageId: "page-1",
        keep: INTERVAL_REVISION_KEEP,
        maxBytes: INTERVAL_REVISION_MAX_BYTES,
      },
    ]);
    expect(stubs.maintenanceErrors).toEqual([]);
    expect(coordinator.getState().status).toBe("saved");
  });

  it("距上次 interval 不足 5 分钟：不创建也不裁剪", async () => {
    const stubs = makeIntervalStubs({
      history: [makeSummary(T0 - INTERVAL_REVISION_MS + 1000, "interval")],
    });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    await saveOnce(coordinator, "内容");

    expect(stubs.adds).toEqual([]);
    expect(stubs.prunes).toEqual([]);
    expect(coordinator.getState().status).toBe("saved");
  });

  it("距上次 interval 达到 5 分钟：创建新快照", async () => {
    const stubs = makeIntervalStubs({
      history: [makeSummary(T0 - INTERVAL_REVISION_MS, "interval")],
      addResult: makeSummary(T0, "interval"),
    });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    await saveOnce(coordinator, "内容");

    expect(stubs.adds).toHaveLength(1);
    expect(stubs.adds[0].reason).toBe("interval");
  });

  it("interval 创建成功后回填节流时间：5 分钟内的后续保存不再创建", async () => {
    const stubs = makeIntervalStubs({
      addResult: makeSummary(T0, "interval"),
    });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    await saveOnce(coordinator, "第一版");
    expect(stubs.adds).toHaveLength(1);

    // 1 分钟后再次保存：lastIntervalAt 已回填为上次保存时间，不再触发。
    stubs.setNow(T0 + 60_000);
    await saveOnce(coordinator, "第二版");
    expect(stubs.adds).toHaveLength(1);
    expect(stubs.prunes).toHaveLength(1);
  });

  it("add 去重命中（返回 null）仍执行 prune 且不报错", async () => {
    const stubs = makeIntervalStubs({ addResult: null });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    await saveOnce(coordinator, "与上一版相同的内容");

    expect(stubs.adds).toHaveLength(1);
    expect(stubs.prunes).toEqual([
      {
        pageId: "page-1",
        keep: INTERVAL_REVISION_KEEP,
        maxBytes: INTERVAL_REVISION_MAX_BYTES,
      },
    ]);
    expect(stubs.maintenanceErrors).toEqual([]);
    expect(coordinator.getState().status).toBe("saved");
  });

  it("capture 失败：正文仍为 saved，经 onMaintenanceError('revision') 上报，后续维护照常", async () => {
    const stubs = makeIntervalStubs({ failAdd: true });
    const coordinator = new DocumentSaveCoordinator("page-1", stubs.deps);

    // 保存 Promise 不因维护失败拒绝。
    await saveOnce(coordinator, "内容");

    expect(coordinator.getState().status).toBe("saved");
    expect(coordinator.getState().errorKind).toBeNull();
    expect(stubs.maintenanceErrors).toHaveLength(1);
    expect(stubs.maintenanceErrors[0].stage).toBe("revision");
    expect(stubs.maintenanceErrors[0].error).toBeInstanceOf(Error);
    // revision 步骤失败不阻断后续维护：附件清理与恢复缓冲清理照常执行。
    expect(stubs.orphanCalls).toEqual(["page-1"]);
    expect(stubs.recoveryClears).toEqual(["page-1"]);
    // capture 失败不产生快照，无需裁剪。
    expect(stubs.prunes).toEqual([]);
  });
});
