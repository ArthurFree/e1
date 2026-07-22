import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { resetDB } from "../infrastructure/db";
import { contentRepository, revisionRepository } from "../infrastructure/repositories";
import { buildDocumentExtensions } from "../editor/extensions";
import { VersionPanel } from "./VersionPanel";

function createEditor(text: string) {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

const PAGE_ID = "p1";

describe("VersionPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("无版本时显示空态", async () => {
    const editor = createEditor("当前内容");
    render(<VersionPanel pageId={PAGE_ID} editor={editor} onClose={() => undefined} />);
    expect(await screen.findByText(/暂无历史版本/)).toBeInTheDocument();
    editor.destroy();
  });

  it("列出版本时间与原因，展开显示摘要", async () => {
    await revisionRepository.add(PAGE_ID, { type: "doc", content: [] }, "旧内容摘要", "interval");
    const editor = createEditor("当前内容");
    render(<VersionPanel pageId={PAGE_ID} editor={editor} onClose={() => undefined} />);

    expect(await screen.findByText("自动")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/旧内容摘要/));
    expect(await screen.findByText("恢复此版本")).toBeInTheDocument();
    editor.destroy();
  });

  it("恢复版本：先存恢复前版本，再写回选中文本", async () => {
    const oldJson = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "历史版本内容" }] }],
    };
    await revisionRepository.add(PAGE_ID, oldJson, "历史版本内容", "interval");
    const editor = createEditor("当前内容");
    const onClose = () => undefined;
    render(<VersionPanel pageId={PAGE_ID} editor={editor} onClose={onClose} />);

    fireEvent.click(await screen.findByText(/历史版本内容/));
    fireEvent.click(await screen.findByText("恢复此版本"));
    fireEvent.click(await screen.findByText("确认恢复？"));

    // 恢复是异步流程：等待当前内容被替换为历史版本
    await waitFor(() => expect(editor.getText()).toContain("历史版本内容"));
    // 恢复前的当前内容已保存为 before-restore 版本
    const revisions = await revisionRepository.listByPage(PAGE_ID);
    expect(revisions.some((r) => r.reason === "before-restore")).toBe(true);
    expect(
      revisions.find((r) => r.reason === "before-restore")?.textSnapshot,
    ).toContain("当前内容");
    // 恢复结果立即落盘
    const saved = await contentRepository.get(PAGE_ID);
    expect(saved?.textSnapshot).toContain("历史版本内容");
    editor.destroy();
  });
});
