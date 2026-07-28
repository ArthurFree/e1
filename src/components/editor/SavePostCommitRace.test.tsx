/**
 * 保存后半程竞态回归测试（R004 阶段 0 基线）：
 * 正文已落盘、维护步骤（自动版本）仍在执行时插入附件并继续编辑，
 * 旧快照的附件清理不得把该窗口内新建的附件当孤儿删除（INV-03）。
 *
 * 时序：编辑 A → A 的 content.save 完成 → revision.add 挂起 →
 * 插入附件（新附件记录 + 触发保存 B）→ 放行 A 的后处理 →
 * 旧快照的 removeOrphans 以 A 的引用集执行，不得误删新附件。
 *
 * 注：保存状态的中间值会被 React 批处理合并，不可作为断言依据；
 * 附件记录存于 IndexedDB，是确定性的可观测结果。
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
  revisionRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { insertAttachmentFile } from "../../editor/attachment";
import { createDeferred, sleep, type Deferred } from "../../test/fixtures";
import type { DocumentRevision } from "../../domain/types";
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

describe("DocumentEditor 保存后半程竞态（R004）", () => {
  let saveGates: Deferred<void>[];
  let revisionGates: Deferred<DocumentRevision | null>[];

  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null, states: [] };
    saveGates = [];
    revisionGates = [];
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "后半程竞态文档",
    });
    // 门控正文保存与版本创建：由测试编排后处理挂起窗口。
    const realSave = contentRepository.save.bind(contentRepository);
    vi.spyOn(contentRepository, "save").mockImplementation(
      (pageId, json, text) => {
        const gate = createDeferred<void>();
        saveGates.push(gate);
        return gate.promise.then(() => realSave(pageId, json, text));
      },
    );
    const realAdd = revisionRepository.add.bind(revisionRepository);
    vi.spyOn(revisionRepository, "add").mockImplementation(
      (pageId, json, text, reason) => {
        const gate = createDeferred<DocumentRevision | null>();
        revisionGates.push(gate);
        return gate.promise.then((created) =>
          created === null ? realAdd(pageId, json, text, reason) : created,
        );
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("版本创建挂起期间插入附件：旧快照收尾不得误删新附件", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    // 编辑 A：保存发起，正文落盘后 revision.add 挂起（快照 A 不含附件）。
    editor.commands.insertContent("保存A的文本");
    await waitFor(() => expect(saveGates.length).toBe(1), { timeout: 4000 });
    saveGates[0].resolve();
    await waitFor(() => expect(revisionGates.length).toBe(1), {
      timeout: 4000,
    });

    // 挂起窗口内插入附件：附件记录落库，文档节点触发保存 B。
    await insertAttachmentFile(
      editor,
      pageId,
      new File(["x"], "b.txt", { type: "text/plain" }),
    );
    expect((await attachmentRepository.listByPage(pageId)).length).toBe(1);
    await sleep(1500);

    // 放行 A 的后处理：A 已过期，其附件清理不得执行/不得误删。
    revisionGates[0].resolve(null);
    // B 的正文保存在 A 收尾后串行发起并完成。
    await waitFor(() => expect(saveGates.length).toBe(2), { timeout: 4000 });
    saveGates[1].resolve();
    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });

    // 全部保存收尾后，新插入的附件记录必须仍然存在。
    await waitFor(
      async () => {
        expect((await attachmentRepository.listByPage(pageId)).length).toBe(1);
      },
      { timeout: 4000 },
    );
  }, 20000);
});
