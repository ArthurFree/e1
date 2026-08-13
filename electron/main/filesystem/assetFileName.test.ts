// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assetFileNameForAttempt,
  sanitizeAssetFileParts,
} from "./assetFileName.js";

describe("sanitizeAssetFileParts", () => {
  it("保留扩展名并小写", () => {
    expect(sanitizeAssetFileParts("架构 图.PNG")).toEqual({
      stem: "架构 图",
      ext: ".png",
    });
  });

  it("无扩展名", () => {
    expect(sanitizeAssetFileParts("README")).toEqual({
      stem: "README",
      ext: "",
    });
  });

  it("Windows 保留名加下划线，扩展名仍保留", () => {
    expect(sanitizeAssetFileParts("CON.png")).toEqual({
      stem: "CON_",
      ext: ".png",
    });
    expect(sanitizeAssetFileParts("nul")).toEqual({
      stem: "nul_",
      ext: "",
    });
  });

  it("非法字符替换为 -", () => {
    expect(sanitizeAssetFileParts("b:c*.txt")).toEqual({
      stem: "b-c-",
      ext: ".txt",
    });
  });
});

describe("assetFileNameForAttempt", () => {
  it("0 → 原名；1 → (2)", () => {
    expect(assetFileNameForAttempt("image", ".png", 0)).toBe("image.png");
    expect(assetFileNameForAttempt("image", ".png", 1)).toBe("image (2).png");
    expect(assetFileNameForAttempt("image", ".png", 2)).toBe("image (3).png");
  });
});
