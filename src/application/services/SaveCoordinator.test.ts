/**
 * DocumentSaveCoordinator 单元测试（R003 §1.1 核心规则）：
 * 串行执行、latest-wins、旧代次不发布 saved、附件清理只在最新快照、
 * 失败重试、flush 语义、恢复缓冲写入/清除。
 * 仓储全部用内存 stub，不依赖 IndexedDB。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRepository,
  ContentRepository,
  RevisionRepository,
} from "../../domain/repositories";
import type { DocumentRevision } from "../../domain/types";
import { createDeferred, type Deferred } from "../../test/fixtures";
import {
  DocumentSaveCoordinator,
  type SaveCoordinatorState,
} from "./SaveCoordinator";
import type { DocumentRecoveryRecord } from "./documentRecovery";

function makeStubs() {
  const saves: { pageId: string; json: unknown; text: string }[] = [];
  const saveGates: Deferred<void>[] = [];
  const orphanCalls: string[][] = [];
  const revisionAdds: string[] = [];
  const recoveryWrites: DocumentRecoveryRecord[] = [];
  const recoveryClears: { pageId: string; savedGeneration: number }[] = [];

  const content: ContentRepository = {
    async get() {
      return undefined;
    },
    async save(pageId, json, text) {
      saves.push({ pageId, json, text });
      // 每次保存自动挂起，由测试按序放行，精确控制完成时机。
      const gate = createDeferred<void>();
      saveGates.push(gate);
      await gate.promise;
    },
    async listAll() {
      return [];
    },
  };
  const revisions: RevisionRepository = {
    async listByPage() {
      return [];
    },
    async add(_pageId, _json, text): Promise<DocumentRevision | null> {
      revisionAdds.push(text);
      return null; // 不创建版本，避免干扰断言；节流逻辑由集成测试覆盖。
    },
    async pruneInterval() {},
  };
  const attachments: AttachmentRepository = {
    async get() {
      return undefined;
    },
    async listByPage() {
      return [];
    },
    async add() {
      throw new Error("未使用");
    },
    async remove() {},
    async removeOrphans(_pageId, referencedIds) {
      orphanCalls.push(referencedIds);
      return 0;
    },
  };
  const recovery = {
    write(record: DocumentRecoveryRecord) {
      recoveryWrites.push(record);
    },
    clear(pageId: string, savedGeneration: number) {
      recoveryClears.push({ pageId, savedGeneration });
    },
  };
  return {
    content,
    revisions,
    attachments,
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
      content: stubs.content,
      revisions: stubs.revisions,
      attachments: stubs.attachments,
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
    const first = coordinator.enqueue({ contentJson: DOC, textSnapshot: "旧内容" });
    // 第一个保存在途（门控挂起），提交第二个快照。
    await Promise.resolve();
    expect(stubs.saves).toHaveLength(1);

    coordinator.noteEdit();
    const second = coordinator.enqueue({ contentJson: DOC, textSnapshot: "新内容" });
    expect(stubs.saves).toHaveLength(1); // 串行：第二个保存尚未发起

    stubs.saveGates[0].resolve();
    await first;
    // 第一个保存完成后，串行队列才发起第二个保存。
    await vi.waitFor(() => expect(stubs.saves).toHaveLength(2));
    expect(stubs.saves[1].text).toBe("新内容");

    stubs.saveGates[1].resolve();
    const result = await second;
    expect(result.generation).toBe(2);
    // 附件清理只在最新快照执行一次。
    expect(stubs.orphanCalls).toHaveLength(1);
    expect(coordinator.getState().status).toBe("saved");
  });

  it("旧代次保存完成时不发布 saved", async () => {
    coordinator.noteEdit();
    const first = coordinator.enqueue({ contentJson: DOC, textSnapshot: "旧内容" });
    await Promise.resolve();

    // 新编辑仅 noteEdit（防抖未入队）时，旧保存完成。
    coordinator.noteEdit();
    stubs.saveGates[0].resolve();
    await first;

    expect(coordinator.getState().status).not.toBe("saved");
  });

  it("保存失败进入 error，retryLatest 重试最新内容", async () => {
    coordinator.noteEdit();
    const failing = coordinator.enqueue({ contentJson: DOC, textSnapshot: "内容" });
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
    expect(coordinator.getState().status).toBe("saved");
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
    const save = coordinator.enqueue({ contentJson: DOC, textSnapshot: "内容" });
    await Promise.resolve();
    expect(stubs.recoveryWrites).toHaveLength(1);
    expect(stubs.recoveryWrites[0].generation).toBe(1);

    stubs.saveGates[0].resolve();
    await save;
    expect(stubs.recoveryClears).toEqual([{ pageId: "page-1", savedGeneration: 1 }]);
  });

  it("dispose 后排斥新的保存请求", async () => {
    await coordinator.dispose();
    await expect(
      coordinator.enqueue({ contentJson: DOC, textSnapshot: "内容" }),
    ).rejects.toThrow("已销毁");
  });
});
