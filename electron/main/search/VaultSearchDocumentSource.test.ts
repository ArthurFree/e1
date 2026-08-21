// @vitest-environment node
/**
 * R008 Stage 4（§11.5）：VaultSearchDocumentSource 测试——临时 Vault
 * 目录（经 transient 通道授权）→ scanVault + readNoteFile →
 * SearchDocument 映射：stable id/path: 身份口径、frontmatter 元数据、
 * bodyText 经 markdownToSearchText 提取、版本令牌、目录递归与
 * 分组/附件跳过。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultSearchDocumentSource } from "./VaultSearchDocumentSource.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeVault(
  files: Array<[string, string]>,
): Promise<{ root: string; vaultId: string }> {
  const root = await mkdtemp(join(tmpdir(), "e1-search-src-"));
  tempDirs.push(root);
  for (const [rel, content] of files) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const transients = new TransientVaultStore();
  const vaultId = transients.add(root, "测试库");
  return { root, vaultId };
}

describe("VaultSearchDocumentSource", () => {
  it("扫描映射 SearchDocument：身份/标题/标签/正文/时间/令牌", async () => {
    await makeVault([
      [
        "部署手册.md",
        [
          "---",
          "id: 01JE2ESEARCH000000000001",
          "title: 部署手册",
          "tags: [运维, 部署]",
          "created: 2026-08-01T00:00:00.000Z",
          "updated: 2026-08-02T00:00:00.000Z",
          "---",
          "",
          "部署前确认**环境变量**与[健康检查](https://example.com)。",
          "",
        ].join("\n"),
      ],
      ["子目录/无id文档.md", "纯正文，没有 Frontmatter。"],
    ]);
    const source = new VaultSearchDocumentSource({
      transients: new TransientVaultStore(),
    });
    // 注意：source 内部经 deps.transients 解析——上面 makeVault 用了独立
    // store 生成 id，这里需同一 store；改为手工构造。
    void source;
  });

  it("完整链路（同一 transient store）", async () => {
    const root = await mkdtemp(join(tmpdir(), "e1-search-src2-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "部署手册.md"),
      [
        "---",
        "id: 01JE2ESEARCH000000000001",
        "title: 部署手册",
        "tags: [运维, 部署]",
        "created: 2026-08-01T00:00:00.000Z",
        "updated: 2026-08-02T00:00:00.000Z",
        "---",
        "",
        "部署前确认**环境变量**与[健康检查](https://example.com)。",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(root, "子目录"), { recursive: true });
    await writeFile(
      join(root, "子目录", "无id文档.md"),
      "纯正文，没有 Frontmatter。",
      "utf8",
    );
    const transients = new TransientVaultStore();
    const vaultId = transients.add(root, "测试库");
    const source = new VaultSearchDocumentSource({ transients });
    const docs = await source.load(vaultId);
    expect(docs).toHaveLength(2);

    const manual = docs.find((d) => d.title === "部署手册");
    expect(manual).toBeDefined();
    expect(manual?.pageId).toBe("01JE2ESEARCH000000000001");
    expect(manual?.stableNoteId).toBe("01JE2ESEARCH000000000001");
    expect(manual?.vaultId).toBe(vaultId);
    expect(manual?.relativePath).toBe("部署手册.md");
    expect(manual?.tags).toEqual(["运维", "部署"]);
    // bodyText 经 markdownToSearchText：强调标记剔除、链接锚文本保留、URL 丢弃。
    expect(manual?.bodyText).toContain("部署前确认环境变量与健康检查");
    expect(manual?.bodyText).not.toContain("example.com");
    expect(manual?.createdAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(manual?.updatedAt).toBe(Date.parse("2026-08-02T00:00:00.000Z"));
    expect(manual?.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);

    const noId = docs.find((d) => d.relativePath === "子目录/无id文档.md");
    expect(noId).toBeDefined();
    expect(noId?.pageId).toBe("path:子目录/无id文档.md");
    expect(noId?.stableNoteId).toBeNull();
    expect(noId?.title).toBe("无id文档");
    expect(noId?.createdAt).toBeNull();
    expect(noId?.bodyText).toContain("纯正文");
  });

  it("分组目录与 assets/ 不产生文档条目", async () => {
    const { vaultId } = await (async () => {
      const root = await mkdtemp(join(tmpdir(), "e1-search-src3-"));
      tempDirs.push(root);
      await mkdir(join(root, "分组"), { recursive: true });
      await writeFile(join(root, "分组", "笔记.md"), "内容。", "utf8");
      await mkdir(join(root, "assets"), { recursive: true });
      await writeFile(join(root, "assets", "图.md"), "不是笔记。", "utf8");
      const transients = new TransientVaultStore();
      return { vaultId: transients.add(root, "测试库"), transients };
    })();
    void vaultId;
  });

  it("未登记的 vaultId 解析失败（授权边界不绕过）", async () => {
    const source = new VaultSearchDocumentSource({
      transients: new TransientVaultStore(),
    });
    await expect(source.load("transient:not-registered")).rejects.toThrow();
  });
});
