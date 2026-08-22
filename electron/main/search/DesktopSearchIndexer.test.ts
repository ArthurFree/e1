// @vitest-environment node
/**
 * R008 Stage 4（§11.5）：DesktopSearchIndexer 测试——
 * 单篇 Markdown → 索引文档（Frontmatter 元数据 + 纯文本提取 + 身份派生），
 * Vault 全量流式产出（跳过读失败文件不阻断）。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  iterateVaultSearchDocuments,
  searchDocumentFromMarkdown,
} from "./DesktopSearchIndexer.js";

const MARKDOWN = [
  "---",
  "id: 01IDX",
  "title: React 笔记",
  "tags: [前端, 框架]",
  "---",
  "",
  "# React 笔记",
  "",
  "组件化与 [Hooks](https://react.dev) 要点。",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
].join("\n");

describe("searchDocumentFromMarkdown", () => {
  it("Frontmatter 元数据 + 纯文本提取（语法不进 bodyText）", () => {
    const document = searchDocumentFromMarkdown({
      vaultId: "v1",
      relativePath: "学习/React.md",
      markdown: MARKDOWN,
      versionToken: "sha256:x",
      modifiedAt: 123,
    });
    expect(document).toMatchObject({
      pageId: "01IDX",
      vaultId: "v1",
      stableNoteId: "01IDX",
      relativePath: "学习/React.md",
      title: "React 笔记",
      tags: ["前端", "框架"],
      updatedAt: 123,
      versionToken: "sha256:x",
    });
    expect(document.bodyText).toContain("组件化与 Hooks 要点。");
    expect(document.bodyText).toContain("const x: number = 1;");
    expect(document.bodyText).not.toContain("https://react.dev");
    expect(document.bodyText).not.toContain("```");
    expect(document.bodyText).not.toContain("---");
  });

  it("无 Frontmatter：path 身份 + 文件名标题", () => {
    const document = searchDocumentFromMarkdown({
      vaultId: "v1",
      relativePath: "杂记/随想.md",
      markdown: "没有 Frontmatter 的正文。",
      versionToken: "sha256:y",
      modifiedAt: 0,
    });
    expect(document).toMatchObject({
      pageId: "path:杂记/随想.md",
      stableNoteId: null,
      title: "随想",
    });
  });
});

describe("iterateVaultSearchDocuments", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e1-search-indexer-"));
    await mkdir(join(root, ".e1"));
    await writeFile(
      join(root, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-idx",
        name: "索引库",
        createdAt: "2026-08-10T00:00:00.000Z",
        assetsDirectory: "assets",
      }),
    );
  });

  it("产出全部 .md 文档（分组跳过；读失败单篇不阻断）", async () => {
    await mkdir(join(root, "学习"));
    await writeFile(join(root, "学习", "React.md"), MARKDOWN);
    await writeFile(join(root, "随想.md"), "正文。");
    // 超过 10 MiB 上限的文件会读失败——用小体积非法 UTF-8 模拟。
    await writeFile(join(root, "坏.md"), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    const documents = [];
    for await (const document of iterateVaultSearchDocuments({
      vaultId: "v-idx",
      vaultRoot: root,
    })) {
      documents.push(document);
    }
    const paths = documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(["学习/React.md", "随想.md"]);
    expect(
      documents.find((d) => d.relativePath === "学习/React.md")?.pageId,
    ).toBe("01IDX");
  });
});
