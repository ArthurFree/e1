/**
 * 版本恢复串行化回归测试（R004 阶段 3，INV-06）：
 * 旧流程「setContent + contentRepository.save」与 800ms 防抖保存互相竞争，
 * 恢复结果可能被恢复前的旧内容盖回。新流程经 DocumentEditorController：
 * flush 防抖与协调器队列 → before-restore 版本 → 协调器串行提交目标版本。
 *
 * 时序：编辑 A（防抖挂起未入队）→ 立即触发恢复 T →
 * A 被 flush 先进队列 → 恢复提交 T 排在其后 → 最终落盘与编辑器均为 T。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useApp } from "../../state/AppState";
import { TestApp } from "../../test/TestApp";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  revisionRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { createDeferred, type Deferred } from "../../test/fixtures";
import type { DocumentEditorController } from "../../application/services/DocumentEditorController";
import { DocumentEditor } from "./DocumentEditor";

let host: {
  editor: Editor | null;
  controller: DocumentEditorController | null;
  pageId: string | null;
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
      onControllerReady={(controller) => {
        host.controller = controller;
      }}
    />
  );
}

const TARGET_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "恢复的目标文本" }] },
  ],
};

describe("版本恢复与编辑器保存串行化（R004 INV-06）", () => {
  let saveGates: Deferred<void>[];

  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, controller: null, pageId: null };
    saveGates = [];
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "恢复竞态文档",
    });
    const realSave = contentRepository.save.bind(contentRepository);
    vi.spyOn(contentRepository, "save").mockImplementation(
      (pageId, json, text) => {
        const gate = createDeferred<void>();
        saveGates.push(gate);
        return gate.promise.then(() => realSave(pageId, json, text));
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("防抖挂起期间触发恢复：旧内容不得覆盖恢复结果", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.controller).not.toBeNull(), {
      timeout: 3000,
    });
    const editor = host.editor!;
    const pageId = host.pageId!;

    // 编辑 A：仅 noteEdit + 防抖挂起（尚未入队）。
    editor.commands.insertContent("编辑A的旧文本");

    // 立即触发恢复：controller 先 flush 防抖（A 入队）再串行提交 T。
    const restorePromise = host.controller!.restore({
      contentJson: TARGET_DOC,
      textSnapshot: "恢复的目标文本",
    });

    // A 的保存先发起（flush 入队），放行。
    await waitFor(() => expect(saveGates.length).toBe(1), { timeout: 4000 });
    expect(saveGates.length).toBe(1);
    saveGates[0].resolve();

    // 恢复提交 T 的保存排在 A 之后（同一串行队列），放行。
    await waitFor(() => expect(saveGates.length).toBe(2), { timeout: 4000 });
    saveGates[1].resolve();
    await restorePromise;

    // 编辑器与落盘均为恢复目标，旧文本 A 没有盖回来。
    expect(editor.getText()).toContain("恢复的目标文本");
    const saved = await contentRepository.get(pageId);
    expect(saved?.textSnapshot).toContain("恢复的目标文本");

    // 恢复前的当前内容（含 A）已留存为版本（before-restore 与 A 的
    // interval 版本内容相同会被去重，故不限定 reason）。
    await waitFor(
      async () => {
        const revisions = await revisionRepository.listByPage(pageId);
        expect(
          revisions.some((r) => r.textSnapshot.includes("编辑A的旧文本")),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
  }, 20000);
});
