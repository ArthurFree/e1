import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "./extensions";
import {
  MAX_ATTACHMENT_BYTES,
  collectAttachmentIds,
  formatBytes,
  insertAttachmentFile,
} from "./attachment";
import { attachmentRepository } from "../infrastructure/repositories";
import { resetDB } from "../infrastructure/db";

function createEditor(content?: unknown) {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: content as never,
  });
}

describe("附件工具函数", () => {
  it("formatBytes 输出人类可读大小", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("collectAttachmentIds 收集嵌套附件引用", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "blockquote",
          content: [
            { type: "attachment", attrs: { attachmentId: "a1" } },
            { type: "attachment", attrs: { attachmentId: "a2" } },
          ],
        },
        { type: "attachment", attrs: { attachmentId: "a3" } },
      ],
    };
    expect(collectAttachmentIds(doc).sort()).toEqual(["a1", "a2", "a3"]);
    expect(collectAttachmentIds(null)).toEqual([]);
  });
});

describe("附件插入", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("超过 20MB 立即提示，不写 IndexedDB 也不插入节点", async () => {
    const editor = createEditor();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const big = new File([""], "big.zip", { type: "application/zip" });
    Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_BYTES + 1 });

    const ok = await insertAttachmentFile(editor, "page-1", big);
    expect(ok).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(await attachmentRepository.listByPage("page-1")).toEqual([]);
    expect(editor.getText()).not.toContain("big.zip");
    editor.destroy();
    alert.mockRestore();
  });

  it("附件写入失败（如存储不足）提示并中止", async () => {
    const editor = createEditor();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const addSpy = vi
      .spyOn(attachmentRepository, "add")
      .mockRejectedValue(new DOMException("quota", "QuotaExceededError"));

    const ok = await insertAttachmentFile(
      editor,
      "page-1",
      new File(["x"], "fail.txt", { type: "text/plain" }),
    );
    expect(ok).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(editor.getJSON().content?.some((n) => n.type === "attachment")).toBeFalsy();
    editor.destroy();
    alert.mockRestore();
    addSpy.mockRestore();
  });

  it("合法文件写入附件记录并插入只含元数据的节点", async () => {
    const editor = createEditor();
    const file = new File(["hello"], "说明.txt", { type: "text/plain" });

    const ok = await insertAttachmentFile(editor, "page-1", file);
    expect(ok).toBe(true);

    const records = await attachmentRepository.listByPage("page-1");
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("说明.txt");

    const node = editor.getJSON().content?.find((n) => n.type === "attachment");
    expect(node?.attrs).toMatchObject({
      attachmentId: records[0].id,
      name: "说明.txt",
      mimeType: "text/plain",
    });
    // 节点 JSON 不携带 Blob。
    expect(JSON.stringify(node)).not.toContain("hello");
    editor.destroy();
  });
});

describe("附件节点视图", () => {
  let editor: Editor | null = null;
  beforeEach(async () => {
    await resetDB();
  });
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function createWithAttachment() {
    return createEditor({
      type: "doc",
      content: [
        {
          type: "attachment",
          attrs: {
            attachmentId: "missing",
            name: "丢失.zip",
            mimeType: "application/zip",
            size: 1024,
          },
        },
      ],
    });
  }

  it("显示文件名与大小，提供下载和移除", () => {
    editor = createWithAttachment();
    const dom = editor.view.dom;
    expect(dom.querySelector(".attachment-block__name")?.textContent).toBe("丢失.zip");
    expect(dom.querySelector(".attachment-block__meta")?.textContent).toContain("1.0 KB");
    expect(
      dom.querySelector<HTMLButtonElement>("[aria-label^='下载附件']"),
    ).not.toBeNull();
    expect(
      dom.querySelector<HTMLButtonElement>("[aria-label^='移除附件']"),
    ).not.toBeNull();
  });

  it("Blob 缺失时下载提示“附件不可用”", async () => {
    editor = createWithAttachment();
    const download = editor.view.dom.querySelector<HTMLButtonElement>(
      "[aria-label^='下载附件']",
    )!;
    download.click();
    await vi.waitFor(() => {
      expect(
        editor!.view.dom.querySelector(".attachment-block__status")?.textContent,
      ).toBe("附件不可用");
    });
    // 节点仍在，可手动移除。
    expect(editor.getJSON().content?.some((n) => n.type === "attachment")).toBe(true);
  });

  it("移除按钮只删除文档引用", async () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const editor2 = createEditor();
    await insertAttachmentFile(editor2, "page-1", file);
    const [record] = await attachmentRepository.listByPage("page-1");

    const remove = editor2.view.dom.querySelector<HTMLButtonElement>(
      "[aria-label^='移除附件']",
    )!;
    remove.click();
    expect(editor2.getJSON().content?.some((n) => n.type === "attachment")).toBe(false);
    // 附件记录仍在，等待保存后的孤儿清理。
    expect(await attachmentRepository.get(record.id)).toBeDefined();
    editor2.destroy();
  });
});
