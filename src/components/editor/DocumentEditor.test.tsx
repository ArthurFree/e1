import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useApp } from "../../state/AppState";
import { TestApp } from "../../test/TestApp";
import { resetDB } from "../../platform/web/persistence/db";
import {
  assetStore,
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "../../platform/web/persistence/repositories";
import { createBrowserAppServices } from "../../platform/web/createBrowserServices";
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
      initialVersion="idb:1"
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
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    await insertAttachmentFile(
      editor,
      pageId,
      new File(["x"], "a.txt", { type: "text/plain" }),
    );
    const [record] = await assetStore.listByDocument(pageId);
    expect(record).toBeDefined();

    // 等待首次防抖保存落盘（引用仍在，附件保留）。
    await waitFor(
      async () => {
        expect((await assetStore.listByDocument(pageId)).length).toBe(1);
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
    editor
      .chain()
      .deleteRange({ from: pos, to: pos + nodeSize })
      .run();
    expect(
      editor.getJSON().content?.some((n) => n.type === "attachment"),
    ).toBeFalsy();
    await waitFor(
      async () => {
        expect((await assetStore.listByDocument(pageId)).length).toBe(0);
      },
      { timeout: 3000 },
    );
  }, 10000);
});

/**
 * 回归（R007 阶段 0）：初始内容即含 localImage 的文档（重启后打开含图
 * 文档），节点视图随 EditorView 创建同步装配，早于 useEffect 的 storage
 * 注入——assetServices 必须在 onBeforeCreate 就绪，否则首屏误降级为
 * 「图片不可用」。
 */
describe("DocumentEditor 初始内容资源注入", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null };
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ImageHarness({ initialContent }: { initialContent: unknown }) {
    const { ready, workspace, pages } = useApp();
    host.pageId = pages.find((p) => p.kind === "document")?.id ?? null;
    if (!ready || !host.pageId || !workspace) return null;
    return (
      <DocumentEditor
        pageId={host.pageId}
        initialContent={initialContent as never}
        initialVersion="idb:1"
        onEditorReady={(editor) => {
          host.editor = editor;
        }}
      />
    );
  }

  it("初始内容含 localImage：首渲染即解析资源，不误报「图片不可用」", async () => {
    const [ws] = await workspaceRepository.list();
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "含图文档",
    });
    const record = await assetStore.add({
      pageId: page.id,
      name: "照片.png",
      mimeType: "image/png",
      size: 4,
      data: new Uint8Array(4),
    });
    const initialContent = {
      type: "doc",
      content: [
        {
          type: "localImage",
          attrs: { attachmentId: record.id, alt: "照片.png", width: null },
        },
      ],
    };

    render(
      <TestApp>
        <ImageHarness initialContent={initialContent} />
      </TestApp>,
    );
    await waitFor(
      () => {
        const img = document.querySelector<HTMLImageElement>(
          ".local-image__img",
        );
        expect(img).not.toBeNull();
        expect(img!.src).toBe("blob:mock-url");
      },
      { timeout: 3000 },
    );
    expect(document.querySelector(".local-image--missing")).toBeNull();
  }, 10000);
});

/**
 * R007 阶段 1（DSK-03）：元数据写入（标题/标签）落盘后经
 * DocumentVersionChannel 推进当前文档协调器的已加载版本——
 * 下一次正文 autosave 以新版本为乐观锁起点，不产生假冲突。
 */
describe("DocumentEditor 版本推进通道", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null };
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "版本推进",
    });
  });

  it("通道发布后，下一次保存以发布版本为 expectedVersion", async () => {
    const saveSpy = vi.spyOn(contentRepository, "save");
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });

    // 首次编辑 → 防抖保存（协调器在此创建，乐观锁起点为加载版本）。
    host.editor!.commands.insertContent("第一段");
    await waitFor(() => expect(saveSpy).toHaveBeenCalled(), { timeout: 4000 });
    const firstExpected = saveSpy.mock.calls[0]![3];
    expect(firstExpected).toBe("idb:1");

    // 元数据写入落盘（标题/标签）：发布新版本令牌。
    const services = createBrowserAppServices();
    services.documentVersionChannel.publish(host.pageId!, "meta:v2");

    // 继续编辑 → 下一次保存以发布版本为乐观锁起点。
    host.editor!.commands.insertContent("第二段");
    await waitFor(
      () => expect(saveSpy.mock.calls.length).toBeGreaterThan(1),
      { timeout: 4000 },
    );
    expect(saveSpy.mock.calls.at(-1)![3]).toBe("meta:v2");
  }, 15000);
});
