/**
 * 本地图片（R004 阶段 6，§6.1）测试：
 * - 插入路径产物为 localImage 节点 + 附件 Blob，正文 JSON 不再出现 Base64；
 * - 统一校验（MIME 白名单/大小）在插入前拦截；
 * - NodeView 经 Object URL 渲染、销毁时 revoke、附件缺失显示占位；
 * - 粘贴图片文件走同一附件化路径；
 * - 旧 Base64 文档继续兼容渲染；
 * - 删除节点后孤儿清理由 removeOrphans 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { buildDocumentExtensions } from "./extensions";
import { collectAttachmentIds, MAX_ATTACHMENT_BYTES } from "./attachment";
import { insertLocalImageFile, localImageFilesPluginKey } from "./localImage";
import { assetStore } from "../platform/web/persistence/repositories";
import { createTestAssetServices } from "../test/assetTestServices";
import { resetDB } from "../platform/web/persistence/db";

function createEditor(content?: unknown) {
  // 先以空文档创建并注入 storage，再 setContent：NodeView 首渲染同步发生，
  // 仓储必须先就绪（与 DocumentEditor 装配顺序一致）。
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: { type: "doc", content: [] },
  });
  const storage = editor.storage as unknown as Record<string, unknown>;
  storage.assetServices = createTestAssetServices();
  storage.attachmentPageId = "page-1";
  if (content) editor.commands.setContent(content as never);
  return editor;
}

function pngFile(name = "插图.png", bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

describe("本地图片插入", () => {
  beforeEach(async () => {
    await resetDB();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("插入产物为 localImage 节点，正文 JSON 不含 Base64", async () => {
    const editor = createEditor();
    const ok = await insertLocalImageFile(editor, "page-1", pngFile());
    expect(ok).toBe(true);

    const json = editor.getJSON();
    const node = json.content?.find((n) => n.type === "localImage");
    expect(node).toBeDefined();
    expect(node?.attrs?.alt).toBe("插图.png");
    // 节点只引用附件 ID；整份正文 JSON 不出现 data: Base64。
    const [record] = await assetStore.listByDocument("page-1");
    expect(record).toBeDefined();
    expect(record.mimeType).toBe("image/png");
    expect(node?.attrs?.attachmentId).toBe(record.id);
    expect(JSON.stringify(json)).not.toContain("data:image");
    editor.destroy();
  });

  it("非白名单图片类型被拒，文档与存储均无副作用", async () => {
    const editor = createEditor();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const tiff = new File(["x"], "图.tiff", { type: "image/tiff" });

    const ok = await insertLocalImageFile(editor, "page-1", tiff);
    expect(ok).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(await assetStore.listByDocument("page-1")).toEqual([]);
    expect(
      editor.getJSON().content?.some((n) => n.type === "localImage"),
    ).toBeFalsy();
    editor.destroy();
  });

  it("超过单附件上限被拒", async () => {
    const editor = createEditor();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const big = pngFile("大图.png");
    Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_BYTES + 1 });

    const ok = await insertLocalImageFile(editor, "page-1", big);
    expect(ok).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(await assetStore.listByDocument("page-1")).toEqual([]);
    editor.destroy();
  });

  it("附件写入配额失败时提示空间不足", async () => {
    const editor = createEditor();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const addSpy = vi
      .spyOn(assetStore, "add")
      .mockRejectedValue(new DOMException("quota", "QuotaExceededError"));

    const ok = await insertLocalImageFile(editor, "page-1", pngFile());
    expect(ok).toBe(false);
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("本地存储空间不足"),
    );
    expect(
      editor.getJSON().content?.some((n) => n.type === "localImage"),
    ).toBeFalsy();
    editor.destroy();
    addSpy.mockRestore();
  });

  it("粘贴图片文件走附件化插入路径", async () => {
    const editor = createEditor();
    const event = {
      clipboardData: { files: [pngFile()] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;

    const handled = editor.view.someProp("handlePaste", (fn) =>
      fn(editor.view, event, Slice.empty),
    );
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    await vi.waitFor(async () => {
      expect(
        editor.getJSON().content?.some((n) => n.type === "localImage"),
      ).toBe(true);
    });
    expect(JSON.stringify(editor.getJSON())).not.toContain("data:image");
    expect(await assetStore.listByDocument("page-1")).toHaveLength(1);
    editor.destroy();
  });

  it("粘贴非图片内容不拦截", () => {
    const editor = createEditor();
    // 直接取本扩展注册的插件，避免其他插件的 handlePaste 干扰断言。
    const plugin = localImageFilesPluginKey.get(editor.state);
    const event = {
      clipboardData: {
        files: [new File(["x"], "a.txt", { type: "text/plain" })],
      },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    const handled = plugin?.props.handlePaste?.call(
      plugin,
      editor.view,
      event,
      Slice.empty,
    );
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    editor.destroy();
  });
});

describe("本地图片节点视图", () => {
  beforeEach(async () => {
    await resetDB();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("经 Object URL 渲染，编辑器销毁时 revoke", async () => {
    // R005 阶段 5：字节以 Uint8Array 落库，fake-indexeddb 可完整往返，
    // 不再需要 R005 之前的 Blob mock 回退。
    const record = await assetStore.add({
      pageId: "page-1",
      name: "照片.png",
      mimeType: "image/png",
      size: 4,
      data: new Uint8Array(4),
    });
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "localImage",
          attrs: { attachmentId: record.id, alt: "照片.png", width: 320 },
        },
      ],
    });

    await vi.waitFor(() => {
      const img =
        editor.view.dom.querySelector<HTMLImageElement>(".local-image__img");
      expect(img).not.toBeNull();
      expect(img!.src).toBe("blob:mock-url");
      expect(img!.alt).toBe("照片.png");
      expect(img!.style.width).toBe("320px");
    });

    editor.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("附件缺失时显示占位", async () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "localImage",
          attrs: { attachmentId: "missing", alt: "丢.png" },
        },
      ],
    });
    await vi.waitFor(() => {
      const dom = editor.view.dom.querySelector(".local-image--missing");
      expect(dom).not.toBeNull();
      expect(dom?.querySelector(".local-image__placeholder")?.textContent).toBe(
        "图片不可用",
      );
    });
    editor.destroy();
  });

  it("旧 Base64 图片文档继续兼容渲染", () => {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const editor = createEditor({
      type: "doc",
      content: [{ type: "image", attrs: { src: dataUri, alt: "旧图" } }],
    });
    const img = editor.view.dom.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.src).toBe(dataUri);
    editor.destroy();
  });
});

describe("本地图片与孤儿清理", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("collectAttachmentIds 收集 localImage 引用；删除节点后 removeOrphans 清理 Blob", async () => {
    const editor = createEditor();
    await insertLocalImageFile(editor, "page-1", pngFile());
    const [record] = await assetStore.listByDocument("page-1");

    // 节点存在时引用被收集，不会被误清。
    expect(collectAttachmentIds(editor.getJSON())).toContain(record.id);

    // 删除图片节点：引用消失，孤儿清理（与附件块同一机制）删除 Blob。
    editor.commands.clearContent();
    expect(collectAttachmentIds(editor.getJSON())).not.toContain(record.id);
    const removed = await assetStore.removeOrphans(
      "page-1",
      collectAttachmentIds(editor.getJSON()),
      { createdBeforeOrAt: Date.now() },
    );
    expect(removed).toBe(1);
    expect(await assetStore.getMetadata(record.id)).toBeUndefined();
    editor.destroy();
  });
});
