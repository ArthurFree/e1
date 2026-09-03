// @vitest-environment node
/**
 * R010 Stage 3（§11）：DesktopLinkIndexer 测试——
 * 单篇 Markdown → 链接索引文档（Frontmatter 身份/标题 + 链接提取），
 * Vault 全量流式产出（跳过读失败文件不阻断）。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  iterateVaultLinkDocuments,
  linkDocumentFromMarkdown,
} from "./DesktopLinkIndexer.js";

const MARKDOWN = [
  "---",
  "id: 01LNK",
  "title: React 笔记",
  "---",
  "",
  "组件化要点，参见 [Vue 入门](../Vue.md) 与 [官网](https://react.dev)。",
  "",
  "```md",
  "[代码块内不提取](x.md)",
  "```",
  "",
].join("\n");

describe("linkDocumentFromMarkdown", () => {
  it("Frontmatter 身份/标题 + 链接提取（围栏代码块屏蔽）", () => {
    const document = linkDocumentFromMarkdown({
      vaultId: "v1",
      relativePath: "学习/React.md",
      markdown: MARKDOWN,
      versionToken: "sha256:x",
    });
    expect(document).toMatchObject({
      noteKey: "01LNK",
      vaultId: "v1",
      stableNoteId: "01LNK",
      relativePath: "学习/React.md",
      title: "React 笔记",
      versionToken: "sha256:x",
    });
    expect(document.links.map((l) => [l.label, l.kind])).toEqual([
      ["Vue 入门", "internal"],
      ["官网", "external"],
    ]);
    // 相对路径以来源目录为基准归一到 vault 根。
    expect(document.links[0].targetRelativePath).toBe("Vue.md");
  });

  it("无 Frontmatter：path 身份 + 文件名标题", () => {
    const document = linkDocumentFromMarkdown({
      vaultId: "v1",
      relativePath: "杂记/随想.md",
      markdown: "没有 Frontmatter 的正文。",
      versionToken: "sha256:y",
    });
    expect(document).toMatchObject({
      noteKey: "path:杂记/随想.md",
      stableNoteId: null,
      title: "随想",
      links: [],
    });
  });
});

describe("iterateVaultLinkDocuments", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e1-link-indexer-"));
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
    await writeFile(join(root, "随想.md"), "正文 [回链](学习/React.md)。");
    // 超过 10 MiB 上限的文件会读失败——用小体积非法 UTF-8 模拟。
    await writeFile(join(root, "坏.md"), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    const documents = [];
    for await (const document of iterateVaultLinkDocuments({
      vaultId: "v-idx",
      vaultRoot: root,
    })) {
      documents.push(document);
    }
    const paths = documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(["学习/React.md", "随想.md"]);
    expect(
      documents.find((d) => d.relativePath === "随想.md")?.links[0],
    ).toMatchObject({ label: "回链", targetRelativePath: "学习/React.md" });
  });
});
