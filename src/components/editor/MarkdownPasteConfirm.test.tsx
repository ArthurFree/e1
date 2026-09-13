/**
 * 粘贴 Markdown 确认弹窗（DocumentEditor 集成）测试：
 * - 粘贴疑似 Markdown 的纯文本 → 弹确认框、不产生编辑；
 * - 「按 Markdown 转换」→ 经白名单解析为所见即所得节点插入；
 * - 「保持纯文本」→ 原文按默认粘贴行为插入，不丢内容。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { useApp } from "../../state/AppState";
import { TestApp } from "../../test/TestApp";
import { resetDB } from "../../platform/web/persistence/db";
import {
  pageRepository,
  workspaceRepository,
} from "../../platform/web/persistence/repositories";
import { DocumentEditor } from "./DocumentEditor";

const host: { editor: Editor | null; pageId: string | null } = {
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
      initialVersion="idb:1"
      onEditorReady={(editor) => {
        host.editor = editor;
      }}
    />
  );
}

const MARKDOWN = "# 粘贴标题\n\n- 列表项一\n- 列表项二";

function simulatePaste(text: string) {
  const editor = host.editor!;
  const event = {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
  const handled = editor.view.someProp("handlePaste", (fn) =>
    fn(editor.view, event, Slice.empty),
  );
  return { handled, event };
}

async function renderEditor() {
  render(
    <TestApp>
      <Harness />
    </TestApp>,
  );
  await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
}

describe("粘贴 Markdown 确认弹窗", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host.editor = null;
    host.pageId = null;
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "粘贴测试",
    });
  });

  it("粘贴疑似 Markdown 文本：弹确认框且文档未被修改", async () => {
    await renderEditor();
    const { handled, event } = simulatePaste(MARKDOWN);
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    expect(
      await screen.findByText("检测到 Markdown 内容", undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    // 弹框期间不产生任何编辑。
    expect(host.editor!.getText()).toBe("");
  });

  it("「按 Markdown 转换」：插入解析后的标题与列表节点", async () => {
    await renderEditor();
    simulatePaste(MARKDOWN);
    const convert = await screen.findByRole("button", {
      name: "按 Markdown 转换",
    });
    fireEvent.click(convert);

    await waitFor(() => {
      const json = host.editor!.getJSON();
      expect(json.content?.some((n) => n.type === "heading")).toBe(true);
      expect(json.content?.some((n) => n.type === "bulletList")).toBe(true);
    });
    expect(host.editor!.getText()).toContain("粘贴标题");
    // 转换后弹窗关闭。
    expect(screen.queryByText("检测到 Markdown 内容")).toBeNull();
  });

  it("「保持纯文本」：原文按默认粘贴行为插入", async () => {
    await renderEditor();
    simulatePaste(MARKDOWN);
    const keep = await screen.findByRole("button", { name: "保持纯文本" });
    fireEvent.click(keep);

    await waitFor(() => {
      expect(host.editor!.getText()).toContain("# 粘贴标题");
      expect(host.editor!.getText()).toContain("列表项二");
    });
    // 未做 Markdown 转换：不出现标题节点。
    expect(
      host.editor!.getJSON().content?.some((n) => n.type === "heading"),
    ).toBeFalsy();
    expect(screen.queryByText("检测到 Markdown 内容")).toBeNull();
  });

  it("粘贴普通文本：不弹确认框", async () => {
    await renderEditor();
    const { handled } = simulatePaste("这只是一段普通的中文文本内容。");
    expect(handled).toBeFalsy();
    expect(screen.queryByText("检测到 Markdown 内容")).toBeNull();
  });
});
