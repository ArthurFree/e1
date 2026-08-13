/**
 * @ 提及候选动态更新测试（R003 阶段 6 验收）：
 * 编辑器实例不重建的前提下，新建/重命名页面后 @ 候选立即反映最新页面。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { TestApp } from "../../test/TestApp";
import { useApp } from "../../state/AppState";
import { resetDB } from "../../platform/web/persistence/db";
import {
  pageRepository,
  workspaceRepository,
} from "../../platform/web/persistence/repositories";
import { DocumentEditor } from "./DocumentEditor";

let host: {
  editor: Editor | null;
  pageId: string | null;
  app: ReturnType<typeof useApp> | null;
};

function Harness() {
  const app = useApp();
  host.app = app;
  host.pageId =
    app.pages.find((p) => p.kind === "document" && p.title === "当前文档")
      ?.id ?? null;
  if (!app.ready || !host.pageId || !app.workspace) return null;
  return (
    <DocumentEditor
      pageId={host.pageId}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialVersion="idb:1"
      onEditorReady={(editor) => {
        host.editor = editor;
      }}
    />
  );
}

/** 读取 @ 弹层的候选标题（弹层挂在 document.body）。 */
function mentionTitles(): string[] {
  return Array.from(document.body.querySelectorAll(".command-list__title")).map(
    (el) => el.textContent ?? "",
  );
}

describe("@ 提及候选动态更新", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null, app: null };
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "当前文档",
    });
  });

  it("新建并重命名页面后，@ 候选立即包含新标题", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });

    // 编辑器已打开：新建页面并重命名（实例不重建）。
    const page = await host.app!.createPage("document", null);
    expect(page).not.toBeNull();
    await host.app!.renamePage(page!.id, "提及目标页");
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.title === "提及目标页")).toBe(true),
    );

    // 触发 @ 弹层：候选应包含新页面（getMentionPages 动态读取）。
    host.editor!.commands.insertContent("@");
    await waitFor(
      () => {
        expect(mentionTitles()).toContain("提及目标页");
      },
      { timeout: 3000 },
    );
    // 原页面也在候选中。
    expect(mentionTitles()).toContain("当前文档");
  }, 15000);
});
