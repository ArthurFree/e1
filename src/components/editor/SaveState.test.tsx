import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { AppProvider, useApp } from "../../state/AppState";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  revisionRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { DocumentEditor, type SaveState } from "./DocumentEditor";

let host: {
  editor: Editor | null;
  pageId: string | null;
  states: SaveState[];
  retry: (() => void) | null;
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
      onRegisterRetry={(retry) => {
        host.retry = retry;
      }}
    />
  );
}

function lastStatus() {
  return host.states[host.states.length - 1]?.status;
}

/** 保存状态机（R001 §8.1）与间隔自动版本（§8.3）。 */
describe("DocumentEditor 保存状态与自动版本", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null, states: [], retry: null };
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "状态文档",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("编辑后依次进入 未保存/保存中/已保存，并生成首个自动版本", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    editor.commands.insertContent("第一段内容");
    await waitFor(() => expect(lastStatus()).toBe("dirty"));
    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });

    const revisions = await revisionRepository.listByPage(pageId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].reason).toBe("interval");

    // 5 分钟内再次保存不产生新的自动版本。
    editor.commands.insertContent("第二段内容");
    await waitFor(
      async () =>
        expect((await contentRepository.get(pageId))?.textSnapshot).toContain(
          "第二段内容",
        ),
      { timeout: 4000 },
    );
    expect(await revisionRepository.listByPage(pageId)).toHaveLength(1);
  }, 15000);

  it("保存失败进入错误态，重试后恢复已保存", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;

    const spy = vi
      .spyOn(contentRepository, "save")
      .mockRejectedValueOnce(new Error("磁盘已满"));
    editor.commands.insertContent("会失败的内容");
    await waitFor(() => expect(lastStatus()).toBe("error"), { timeout: 4000 });

    spy.mockRestore();
    expect(host.retry).not.toBeNull();
    host.retry!();
    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });
    const saved = await contentRepository.get(host.pageId!);
    expect(saved?.textSnapshot).toContain("会失败的内容");
  }, 15000);
});
