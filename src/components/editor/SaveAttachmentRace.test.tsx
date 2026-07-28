/**
 * 附件清理竞态回归测试（R003 阶段 0 基线）：
 * 插入附件后，引用旧快照的保存流程不得把新附件当孤儿清理掉。
 *
 * 时序：保存 A（无附件快照）在途 → 插入附件 → 保存 B（含附件快照）→
 * B 先完成、A 后完成。只有最新快照的保存成功后才允许执行孤儿清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useApp } from "../../state/AppState";
import { TestApp } from "../../test/TestApp";
import { resetDB } from "../../infrastructure/db";
import {
  attachmentRepository,
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { insertAttachmentFile } from "../../editor/attachment";
import { createDeferred, sleep, type Deferred } from "../../test/fixtures";
import { DocumentEditor, type SaveState } from "./DocumentEditor";

let host: {
  editor: Editor | null;
  pageId: string | null;
  states: SaveState[];
};

function Harness() {
  const { ready, workspace, pages } = useApp();
  host.pageId = pages.find((p) => p.kind === "document")?.id ?? null;
  if (!ready || !host.pageId || !workspace) return null;
  return (
    <DocumentEditor
      pageId={host.pageId}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialVersion={1}
      onEditorReady={(editor) => {
        host.editor = editor;
      }}
      onSaveStateChange={(state) => {
        host.states.push(state);
      }}
    />
  );
}

function lastStatus() {
  return host.states[host.states.length - 1]?.status;
}

describe("DocumentEditor 附件清理竞态", () => {
  let saveCalls: Deferred<void>[];

  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null, states: [] };
    saveCalls = [];
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "附件竞态文档",
    });
    // 门控保存：resolve 顺序即落库顺序，由测试编排乱序完成。
    const realSave = contentRepository.save.bind(contentRepository);
    vi.spyOn(contentRepository, "save").mockImplementation(
      (pageId, json, text, expectedVersion) => {
        const gate = createDeferred<void>();
        saveCalls.push(gate);
        return gate.promise.then(() =>
          realSave(pageId, json, text, expectedVersion),
        );
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("旧快照的保存完成不得误删新插入的附件", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    // 保存 A（不含附件的快照）发起并挂起。
    editor.commands.insertContent("保存A的文本");
    await waitFor(() => expect(saveCalls.length).toBe(1), { timeout: 4000 });

    // A 在途时插入附件：附件记录 + 文档节点触发保存 B。
    await insertAttachmentFile(
      editor,
      pageId,
      new File(["x"], "b.txt", { type: "text/plain" }),
    );
    expect((await attachmentRepository.listByPage(pageId)).length).toBe(1);
    await sleep(1500);

    // 乱序完成：B 先、A 后（串行实现中 B 在 A 完成后才发起，编排同样适用）。
    saveCalls[1]?.resolve();
    saveCalls[0].resolve();
    await waitFor(() => expect(saveCalls.length).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
    });
    saveCalls[1].resolve();

    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });
    // 全部保存收尾后，被最新快照引用的附件记录必须仍然存在。
    await waitFor(
      async () => {
        expect((await attachmentRepository.listByPage(pageId)).length).toBe(1);
      },
      { timeout: 4000 },
    );
  }, 15000);
});
