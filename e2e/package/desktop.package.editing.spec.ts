// R009 Stage 3：Packaged App E2E —— P03 编辑/保存重启保持 / P04 附件重启保持。
// describe 以「安装包冒烟」为前缀，独立运行用 npm run test:e2e:package。
// P04 导入走 bytes 路径（e1.asset.import 直调 IPC，source.kind="bytes"），
// 不经原生文件对话框——参照 desktop.assets.spec.ts E2E-04 的手法；
// 图片经 e1-asset:// 协议渲染，重启后仍显示即证明 packaged 下协议注册与
// AssetFileSystem 均正常。
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("安装包冒烟：编辑保存与附件（P03/P04）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P03：输入 → 自动保存 → 重启 → 内容仍在", async () => {
    const rel = "安装包笔记.md";
    const fixture = await createPackageVaultFixture(
      [[rel, note("01JE2EPKG0000000000201", "安装包笔记", "原始正文。")]],
      "v-e2e-pkg-saving",
    );
    const abs = path.join(fixture.vaultDir, rel);

    const app1 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await window.getByRole("treeitem", { name: /安装包笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("原始正文。", { timeout: 15_000 });
      await editor.click();
      await window.keyboard.type("安装包写入。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => readFile(abs, "utf8"))
        .toContain("安装包写入。");
    } finally {
      await app1.close();
    }

    // 重启（同一 userData + 同一 Vault）：内容仍在。
    const app2 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("treeitem", { name: /安装包笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("安装包写入。", { timeout: 15_000 });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("P04：bytes 导入附件 → 引用进文档 → 重启 → 附件仍显示", async () => {
    const rel = "插图笔记.md";
    const fixture = await createPackageVaultFixture(
      [[rel, note("01JE2EPKG0000000000202", "插图笔记", "正文。")]],
      "v-e2e-pkg-assets",
    );

    const app1 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      // 等 Vault 打开完成（树渲染）后再发 IPC。
      await expect(
        window.getByRole("treeitem", { name: /插图笔记/ }),
      ).toBeVisible({ timeout: 15_000 });

      // bytes 路径导入（避开原生文件对话框）：Vault 已初始化 → assets/ 落盘。
      await window.evaluate(
        async ({ vaultId, bytes }) => {
          const e1 = (
            window as unknown as {
              e1: {
                asset: {
                  import(input: unknown): Promise<unknown>;
                };
              };
            }
          ).e1;
          await e1.asset.import({
            vaultId,
            fileName: "pack.png",
            mimeType: "image/png",
            source: { kind: "bytes", data: new Uint8Array(bytes) },
          });
        },
        { vaultId: fixture.vaultId, bytes: Array.from(PNG) },
      );
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "pack.png")),
      ).toBe(true);

      // 文档处于未打开状态，直接改盘写入图片引用（watcher 只刷新树，无冲突）。
      await writeFile(
        path.join(fixture.vaultDir, rel),
        note(
          "01JE2EPKG0000000000202",
          "插图笔记",
          "正文。\n\n![pack](assets/pack.png)",
        ),
        "utf8",
      );

      await window.getByRole("treeitem", { name: /插图笔记/ }).click();
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("图片不可用")).toHaveCount(0);
    } finally {
      await app1.close();
    }

    // 重启：附件经 e1-asset:// 协议仍正常渲染。
    const app2 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("treeitem", { name: /插图笔记/ }).click();
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("图片不可用")).toHaveCount(0);
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
