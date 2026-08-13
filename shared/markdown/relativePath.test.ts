/**
 * R006-C5：relativeVaultPath 嵌套笔记相对路径。
 */
import { describe, expect, it } from "vitest";
import { relativeVaultPath } from "./relativePath.js";

describe("relativeVaultPath", () => {
  it("同目录 → 仅文件名", () => {
    expect(relativeVaultPath("学习/a.md", "学习/b.md")).toBe("b.md");
  });

  it("嵌套笔记到根 assets", () => {
    expect(relativeVaultPath("学习/前端/React.md", "assets/fiber.png")).toBe(
      "../../assets/fiber.png",
    );
  });

  it("根笔记到 assets", () => {
    expect(relativeVaultPath("随笔.md", "assets/a.png")).toBe("assets/a.png");
  });
});
