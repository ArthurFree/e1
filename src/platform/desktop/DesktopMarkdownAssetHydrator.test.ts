import { describe, expect, it } from "vitest";
import { relativeVaultPath } from "../../../shared/markdown/relativePath";
import { hydrateDesktopMarkdownAssets } from "./DesktopMarkdownAssetHydrator";
import { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import { createMarkdownCodec } from "../../editor/markdown/codec";

const codec = createMarkdownCodec();

describe("DesktopMarkdownAssetHydrator", () => {
  it("相对图片 → localImage；嵌套 note 路径", async () => {
    const registry = new DesktopAssetRegistry();
    const parsed = await codec.parse({
      markdown: "![Fiber](../../assets/fiber.png)\n",
      relativePath: "学习/前端/React.md",
    });
    const { document } = hydrateDesktopMarkdownAssets({
      vaultId: "v1",
      pageId: "p1",
      noteRelativePath: "学习/前端/React.md",
      document: parsed.document,
      assets: parsed.assets,
      assetsDirectory: "assets",
      registry,
    });
    const json = JSON.stringify(document);
    expect(json).toContain("localImage");
    expect(json).not.toContain('"type":"image"');
    expect(registry.findByPath("v1", "assets/fiber.png")).toBeDefined();
  });

  it("整段文件链接 → attachment；内嵌链接保持 link", async () => {
    const registry = new DesktopAssetRegistry();
    const parsed = await codec.parse({
      markdown: "[design.pdf](../assets/design.pdf)\n\n见 [design.pdf](../assets/design.pdf) 说明。\n",
      relativePath: "学习/a.md",
    });
    const { document } = hydrateDesktopMarkdownAssets({
      vaultId: "v1",
      pageId: "p1",
      noteRelativePath: "学习/a.md",
      document: parsed.document,
      assets: parsed.assets,
      assetsDirectory: "assets",
      registry,
    });
    const doc = document as { content?: Array<{ type?: string }> };
    expect(doc.content?.some((n) => n.type === "attachment")).toBe(true);
    const json = JSON.stringify(document);
    expect(json).toContain('"type":"link"');
  });

  it("外部 URL 与 Vault 外路径不升级", async () => {
    const registry = new DesktopAssetRegistry();
    const parsed = await codec.parse({
      markdown: "![远程](https://example.com/a.png)\n\n![外](../other/x.png)\n",
      relativePath: "笔记.md",
    });
    const { document } = hydrateDesktopMarkdownAssets({
      vaultId: "v1",
      pageId: "p1",
      noteRelativePath: "笔记.md",
      document: parsed.document,
      assets: parsed.assets,
      assetsDirectory: "assets",
      registry,
    });
    const json = JSON.stringify(document);
    expect(json).not.toContain("localImage");
    expect(registry.listByDocument("p1")).toEqual([]);
  });

  it("parse → hydrate → serialize 路径语义等价", async () => {
    const registry = new DesktopAssetRegistry();
    const markdown = "![Fiber](../assets/fiber.png)\n";
    const parsed = await codec.parse({
      markdown,
      relativePath: "学习/React.md",
    });
    const { document } = hydrateDesktopMarkdownAssets({
      vaultId: "v1",
      pageId: "p1",
      noteRelativePath: "学习/React.md",
      document: parsed.document,
      assets: parsed.assets,
      assetsDirectory: "assets",
      registry,
    });
    const serialized = await codec.serialize({
      document,
      metadata: {},
      assetResolver: {
        resolveAssetPath: ({ attachmentId }) => {
          const rec = registry.get(attachmentId);
          if (!rec) return "../assets/fiber.png";
          return relativeVaultPath("学习/React.md", rec.relativePath);
        },
      },
      mode: "portable",
    });
    expect(serialized.markdown).toContain("](../assets/fiber.png)");
    expect(serialized.lossy).toBe(false);
  });
});
