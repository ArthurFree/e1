import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { AppProvider, useApp } from "../../state/AppState";
import { resetDB } from "../../infrastructure/db";
import {
  attachmentRepository,
  pageRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { insertAttachmentFile } from "../../editor/attachment";
import { DocumentEditor } from "./DocumentEditor";

let host: { editor: Editor | null; pageId: string | null } = {
  editor: null,
  pageId: null,
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
    />
  );
}

/** 保存完成后执行孤儿附件清理：移除节点 → 防抖保存 → 附件记录被删除。 */
describe("DocumentEditor 附件孤儿清理", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null };
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "附件文档",
    });
  });

  it("移除附件块并保存后清理附件记录", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    await insertAttachmentFile(editor, pageId, new File(["x"], "a.txt", { type: "text/plain" }));
    const [record] = await attachmentRepository.listByPage(pageId);
    expect(record).toBeDefined();

    // 等待首次防抖保存落盘（引用仍在，附件保留）。
    await waitFor(
      async () => {
        expect((await attachmentRepository.listByPage(pageId)).length).toBe(1);
      },
      { timeout: 3000 },
    );

    // 删除文档中的附件节点，等待保存后孤儿清理。
    let pos = -1;
    let nodeSize = 0;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === "attachment") {
        pos = p;
        nodeSize = node.nodeSize;
        return false;
      }
      return true;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    editor.chain().deleteRange({ from: pos, to: pos + nodeSize }).run();
    expect(editor.getJSON().content?.some((n) => n.type === "attachment")).toBeFalsy();
    await waitFor(
      async () => {
        expect((await attachmentRepository.listByPage(pageId)).length).toBe(0);
      },
      { timeout: 3000 },
    );
  }, 10000);
});
