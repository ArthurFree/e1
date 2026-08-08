import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { resetDB, getDB, STORE_PAGES } from "../infrastructure/db";
import {
  contentRepository,
  revisionRepository,
} from "../infrastructure/repositories";
import { createBrowserAppServices } from "../infrastructure/browserServices";
import type { AppServices } from "../application/AppServices";
import type { DocumentEditorController } from "../application/services/DocumentEditorController";
import { AppServicesProvider } from "../state/AppServicesProvider";
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

/**
 * 手工控制器：与 DocumentEditor 的控制器同语义（恢复经保存协调器串行提交），
 * 用于在不挂载完整编辑器宿主的情况下测试 VersionPanel 的恢复流程。
 */
function createController(
  editor: Editor,
  services: AppServices,
): DocumentEditorController {
  const coordinator = services.createSaveCoordinator(PAGE_ID);
  return {
    getSnapshot: () => ({
      contentJson: editor.getJSON(),
      textSnapshot: editor.getText(),
    }),
    flush: () => coordinator.flush(),
    restore: async (target) => {
      const current = {
        contentJson: editor.getJSON(),
        textSnapshot: editor.getText(),
      };
      await services.commands.document.restoreRevision({
        pageId: PAGE_ID,
        current,
        target,
        commit: (contentJson, textSnapshot) => {
          editor.commands.setContent(contentJson as never);
          return coordinator.enqueue({ contentJson, textSnapshot });
        },
      });
    },
  };
}

describe("VersionPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    // 保存路径要求页面存在（R004 阶段 5：content.save 读页面回写 workspaceId）。
    const db = await getDB();
    const now = Date.now();
    await db.put(STORE_PAGES, {
      id: PAGE_ID,
      workspaceId: "ws1",
      parentId: null,
      kind: "document",
      title: "文档",
      icon: null,
      position: 0,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("无版本时显示空态", async () => {
    const services = createBrowserAppServices();
    const editor = createEditor("当前内容");
    render(
      <AppServicesProvider services={services}>
        <VersionPanel
          pageId={PAGE_ID}
          controller={createController(editor, services)}
          onClose={() => undefined}
        />
      </AppServicesProvider>,
    );
    expect(await screen.findByText(/暂无历史版本/)).toBeInTheDocument();
    editor.destroy();
  });

  it("列出版本时间与原因，展开显示摘要", async () => {
    await revisionRepository.add(
      PAGE_ID,
      { type: "doc", content: [] },
      "旧内容摘要",
      "interval",
    );
    const services = createBrowserAppServices();
    const editor = createEditor("当前内容");
    render(
      <AppServicesProvider services={services}>
        <VersionPanel
          pageId={PAGE_ID}
          controller={createController(editor, services)}
          onClose={() => undefined}
        />
      </AppServicesProvider>,
    );

    expect(await screen.findByText("自动")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/旧内容摘要/));
    expect(await screen.findByText("恢复此版本")).toBeInTheDocument();
    editor.destroy();
  });

  it("恢复版本：先存恢复前版本，再经协调器写回选中文本", async () => {
    const oldJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "历史版本内容" }],
        },
      ],
    };
    await revisionRepository.add(PAGE_ID, oldJson, "历史版本内容", "interval");
    const services = createBrowserAppServices();
    const editor = createEditor("当前内容");
    render(
      <AppServicesProvider services={services}>
        <VersionPanel
          pageId={PAGE_ID}
          controller={createController(editor, services)}
          onClose={() => undefined}
        />
      </AppServicesProvider>,
    );

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
    // 恢复结果经协调器串行落盘（等待队列排空后断言）
    const controller = createController(editor, services);
    await controller.flush();
    const saved = await contentRepository.get(PAGE_ID);
    expect(saved?.textSnapshot).toContain("历史版本内容");
    editor.destroy();
  });

  it("损坏版本拒绝恢复：提示错误且不改动编辑器与存储", async () => {
    const badJson = { type: "doc", content: [{ type: "evilNode" }] };
    await revisionRepository.add(PAGE_ID, badJson, "损坏版本摘要", "interval");
    const services = createBrowserAppServices();
    const editor = createEditor("当前内容");
    render(
      <AppServicesProvider services={services}>
        <VersionPanel
          pageId={PAGE_ID}
          controller={createController(editor, services)}
          onClose={() => undefined}
        />
      </AppServicesProvider>,
    );

    fireEvent.click(await screen.findByText(/损坏版本摘要/));
    fireEvent.click(await screen.findByText("恢复此版本"));
    fireEvent.click(await screen.findByText("确认恢复？"));

    expect(
      await screen.findByText(/该版本内容损坏，无法恢复/),
    ).toBeInTheDocument();
    // 编辑器内容未被替换。
    expect(editor.getText()).toContain("当前内容");
    // 未创建恢复前版本，也未写回存储。
    const revisions = await revisionRepository.listByPage(PAGE_ID);
    expect(revisions.every((r) => r.reason !== "before-restore")).toBe(true);
    expect(await contentRepository.get(PAGE_ID)).toBeUndefined();
    editor.destroy();
  });
});
