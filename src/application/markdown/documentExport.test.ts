/**
 * 导出资源解析器与文档级导出集成测试（R005 阶段 4，批次 4B）。
 *
 * 覆盖：
 * - 资源引用收集（文档顺序、attachmentId 去重）；
 * - 路径确定性与同名冲突递增（name.ext → name (2).ext）；
 * - 缺失附件不抛错：记入 missing + 导出降级为可见占位文本；
 * - 含 localImage + attachment 的文档导出 ZIP：md 引用相对路径、
 *   资源字节与仓储一致、同一输入两次导出字节级一致；
 * - 无资源文档维持单 Markdown 导出、无 Frontmatter。
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryRepositories,
  createMemoryStore,
} from "../../infrastructure/memory/repositories";
import { InMemoryAssetAccessService } from "../../infrastructure/memory/assetServices";
import { exportDocumentMarkdown } from "./documentExport";
import {
  allocateUniqueName,
  collectDocumentAssetRefs,
  prepareExportAssets,
  sanitizeFileName,
} from "./assetResolver";

function createRepos() {
  const repos = createInMemoryRepositories(createMemoryStore());
  // R005 阶段 5：导出经 AssetAccessService 读取资源（内存实现）。
  return { repos, access: new InMemoryAssetAccessService(repos.assetStore) };
}

function localImageNode(
  attachmentId: string,
  alt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "localImage",
    attrs: { attachmentId, alt, width: null, ...extra },
  };
}

function attachmentNode(attachmentId: string, name: string) {
  return { type: "attachment", attrs: { attachmentId, name } };
}

const decoder = new TextDecoder();

/** 解析 ZIP local file headers（STORED 专用测试辅助）。 */
function unzipEntries(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(
      zip.subarray(offset + 30, offset + 30 + nameLength),
    );
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(name, zip.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

async function addAttachment(
  repos: ReturnType<typeof createRepos>["repos"],
  name: string,
  bytes: number[],
) {
  return repos.assetStore.add({
    pageId: "page-1",
    name,
    mimeType: "application/octet-stream",
    size: bytes.length,
    data: new Uint8Array(bytes),
  });
}

describe("collectDocumentAssetRefs", () => {
  it("按文档顺序收集并依 attachmentId 去重", () => {
    const refs = collectDocumentAssetRefs({
      type: "doc",
      content: [
        localImageNode("a1", "图一"),
        attachmentNode("a2", "说明书.pdf"),
        localImageNode("a1", "图一"),
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
        attachmentNode("a3", "数据.csv"),
      ],
    });
    expect(refs).toEqual([
      { attachmentId: "a1", suggestedName: "图一", kind: "image" },
      { attachmentId: "a2", suggestedName: "说明书.pdf", kind: "attachment" },
      { attachmentId: "a3", suggestedName: "数据.csv", kind: "attachment" },
    ]);
  });
});

describe("sanitizeFileName / allocateUniqueName", () => {
  it("净化目录分隔符与首尾点", () => {
    expect(sanitizeFileName("a/b\\c.png", "file")).toBe("a-b-c.png");
    expect(sanitizeFileName("  ..  ", "file")).toBe("file");
    expect(sanitizeFileName("", "file")).toBe("file");
  });

  it("同名冲突按 (2)/(3) 递增，扩展名保留", () => {
    const taken = new Set(["报告.pdf", "报告 (2).pdf"]);
    expect(allocateUniqueName("报告.pdf", taken)).toBe("报告 (3).pdf");
    expect(allocateUniqueName("无扩展名", new Set(["无扩展名"]))).toBe(
      "无扩展名 (2)",
    );
  });
});

describe("prepareExportAssets", () => {
  it("同名附件确定性递增命名；缺失记录记入 missing 不抛错", async () => {
    const { repos, access } = createRepos();
    const first = await addAttachment(repos, "photo.png", [1, 2, 3]);
    const second = await addAttachment(repos, "photo.png", [4, 5]);
    const prepared = await prepareExportAssets(
      [
        { attachmentId: first.id, suggestedName: "x", kind: "image" },
        { attachmentId: second.id, suggestedName: "y", kind: "image" },
        {
          attachmentId: "missing-id",
          suggestedName: "丢失.png",
          kind: "image",
        },
      ],
      access,
    );
    expect(prepared.files.map((f) => f.path)).toEqual([
      "assets/photo.png",
      "assets/photo (2).png",
    ]);
    expect(prepared.missing).toEqual([
      { attachmentId: "missing-id", suggestedName: "丢失.png", kind: "image" },
    ]);
    expect(
      prepared.resolver.resolveAssetPath({
        attachmentId: second.id,
        name: "y",
        kind: "image",
      }),
    ).toBe("assets/photo (2).png");
  });

  it("同一输入两次准备产出相同路径（确定性）", async () => {
    const { repos, access } = createRepos();
    const record = await addAttachment(repos, "a.png", [1]);
    const refs = [
      { attachmentId: record.id, suggestedName: "a", kind: "image" as const },
    ];
    const one = await prepareExportAssets(refs, access);
    const two = await prepareExportAssets(refs, access);
    expect(one.files.map((f) => f.path)).toEqual(two.files.map((f) => f.path));
  });
});

describe("exportDocumentMarkdown", () => {
  it("无资源文档：维持单 Markdown 导出，无 Frontmatter", async () => {
    const { access } = createRepos();
    const result = await exportDocumentMarkdown({
      title: "纯文本笔记",
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "标题" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "正文内容" }] },
        ],
      },
      assetAccess: access,
    });
    expect(result.kind).toBe("markdown");
    if (result.kind !== "markdown") return;
    expect(result.fileName).toBe("纯文本笔记.md");
    expect(result.markdown).not.toMatch(/^---/);
    expect(result.markdown).toContain("# 标题");
    expect(result.markdown).toContain("正文内容");
    expect(result.lossy).toBe(false);
  });

  it("含图片与附件：导出 ZIP，md 引用相对路径，资源字节一致", async () => {
    const { repos, access } = createRepos();
    const imageBytes = [0x89, 0x50, 0x4e, 0x47];
    const pdfBytes = [0x25, 0x50, 0x44, 0x46];
    const image = await addAttachment(repos, "截图.png", imageBytes);
    const pdf = await addAttachment(repos, "说明书.pdf", pdfBytes);

    const result = await exportDocumentMarkdown({
      title: "我的笔记",
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "前文" }] },
          localImageNode(image.id, "截图.png"),
          attachmentNode(pdf.id, "说明书.pdf"),
        ],
      },
      assetAccess: access,
    });

    expect(result.kind).toBe("zip");
    if (result.kind !== "zip") return;
    expect(result.fileName).toBe("我的笔记.zip");
    expect(result.entryNames).toEqual([
      "我的笔记.md",
      "assets/截图.png",
      "assets/说明书.pdf",
    ]);

    const entries = unzipEntries(result.data);
    const markdown = decoder.decode(entries.get("我的笔记.md"));
    expect(markdown).toContain("![截图.png](assets/截图.png)");
    expect(markdown).toContain("[说明书.pdf](assets/说明书.pdf)");
    expect(markdown).not.toMatch(/^---/);
    expect([...entries.get("assets/截图.png")!]).toEqual(imageBytes);
    expect([...entries.get("assets/说明书.pdf")!]).toEqual(pdfBytes);
    expect(result.assetCount).toBe(2);
    expect(result.lossy).toBe(false);
  });

  it("确定性：同一文档两次导出 ZIP 字节级一致", async () => {
    const { repos, access } = createRepos();
    const image = await addAttachment(repos, "a.png", [1, 2]);
    const input = {
      title: "笔记",
      document: { type: "doc", content: [localImageNode(image.id, "a.png")] },
      assetAccess: access,
    };
    const first = await exportDocumentMarkdown(input);
    const second = await exportDocumentMarkdown(input);
    if (first.kind !== "zip" || second.kind !== "zip") {
      throw new Error("预期 ZIP 导出");
    }
    expect([...first.data]).toEqual([...second.data]);
  });

  it("附件记录缺失：降级为可见占位文本并计入 unsupported，不中断导出", async () => {
    const { repos, access } = createRepos();
    const present = await addAttachment(repos, "在的.png", [7, 7]);
    const result = await exportDocumentMarkdown({
      title: "笔记",
      document: {
        type: "doc",
        content: [
          localImageNode("ghost-id", "丢失的图"),
          localImageNode(present.id, "在的.png"),
        ],
      },
      assetAccess: access,
    });
    expect(result.kind).toBe("zip");
    if (result.kind !== "zip") return;
    const entries = unzipEntries(result.data);
    const markdown = decoder.decode(entries.get("笔记.md"));
    expect(markdown).toContain("（图片：丢失的图）");
    expect(markdown).toContain("![在的.png](assets/在的.png)");
    expect(result.lossy).toBe(true);
    expect(result.unsupported.map((u) => u.kind)).toContain("missing-asset");
  });

  it("同名附件在 ZIP 内确定性递增命名", async () => {
    const { repos, access } = createRepos();
    const first = await addAttachment(repos, "photo.png", [1]);
    const second = await addAttachment(repos, "photo.png", [2]);
    const result = await exportDocumentMarkdown({
      title: "笔记",
      document: {
        type: "doc",
        content: [
          localImageNode(first.id, "photo.png"),
          localImageNode(second.id, "photo.png"),
        ],
      },
      assetAccess: access,
    });
    if (result.kind !== "zip") throw new Error("预期 ZIP 导出");
    expect(result.entryNames).toEqual([
      "笔记.md",
      "assets/photo.png",
      "assets/photo (2).png",
    ]);
    const entries = unzipEntries(result.data);
    const markdown = decoder.decode(entries.get("笔记.md"));
    expect(markdown).toContain("](assets/photo.png)");
    expect(markdown).toContain("](assets/photo (2).png)");
  });

  it("标题含目录分隔符：文件名净化，不产生伪目录条目", async () => {
    const { repos, access } = createRepos();
    const image = await addAttachment(repos, "a.png", [1]);
    const result = await exportDocumentMarkdown({
      title: "工作/计划",
      document: { type: "doc", content: [localImageNode(image.id, "a.png")] },
      assetAccess: access,
    });
    if (result.kind !== "zip") throw new Error("预期 ZIP 导出");
    expect(result.fileName).toBe("工作-计划.zip");
    expect(result.entryNames[0]).toBe("工作-计划.md");
  });
});
