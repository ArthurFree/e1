/**
 * R010 Stage 0：链接语义冻结测试。
 *
 * 覆盖需求清单：中文路径、空格、URL encoding、./、../、重复标题、
 * fragment、mailto、纯锚点、外部协议、asset、vault 外逃逸（→ 不可解析）。
 */
import { describe, expect, it } from "vitest";

import {
  classifyLinkHref,
  decodeLinkPath,
  resolveLinkPath,
  splitHref,
} from "./linkKind.js";

describe("classifyLinkHref", () => {
  it("相对 .md 链接 → internal（同级 / ./ / ../）", () => {
    expect(classifyLinkHref("target.md").kind).toBe("internal");
    expect(classifyLinkHref("./target.md").kind).toBe("internal");
    expect(classifyLinkHref("../folder/target.md").kind).toBe("internal");
    expect(classifyLinkHref("../目录/页面.MD").kind).toBe("internal");
  });

  it("带 fragment 的相对 .md 链接 → internal，并剥离 fragment", () => {
    const result = classifyLinkHref("target.md#heading");
    expect(result.kind).toBe("internal");
    expect(result.path).toBe("target.md");
    expect(result.fragment).toBe("heading");
  });

  it("http/https 与协议相对 → external", () => {
    expect(classifyLinkHref("https://example.com/x.md").kind).toBe("external");
    expect(classifyLinkHref("http://example.com").kind).toBe("external");
    expect(classifyLinkHref("//cdn.example.com/a.md").kind).toBe("external");
  });

  it("mailto → mailto", () => {
    expect(classifyLinkHref("mailto:a@b.com").kind).toBe("mailto");
  });

  it("其他协议（ftp/tel 等）→ external", () => {
    expect(classifyLinkHref("ftp://example.com/f.md").kind).toBe("external");
    expect(classifyLinkHref("tel:+123").kind).toBe("external");
  });

  it("绝对路径 → external（不属于 vault 相对引用）", () => {
    expect(classifyLinkHref("/abs/path/x.md").kind).toBe("external");
  });

  it("纯锚点 → anchor", () => {
    const result = classifyLinkHref("#本节");
    expect(result.kind).toBe("anchor");
    expect(result.path).toBe("");
    expect(result.fragment).toBe("本节");
  });

  it("相对非 .md 文件 → asset", () => {
    expect(classifyLinkHref("../assets/design.pdf").kind).toBe("asset");
    expect(classifyLinkHref("./图片.png").kind).toBe("asset");
  });

  it("百分号编码的 .md 后缀同样识别为 internal", () => {
    expect(classifyLinkHref("%E4%B8%AD%E6%96%87.md").kind).toBe("internal");
    expect(classifyLinkHref("my%20note.md").kind).toBe("internal");
  });
});

describe("decodeLinkPath", () => {
  it("解码中文与空格", () => {
    expect(decodeLinkPath("%E4%B8%AD%E6%96%87")).toBe("中文");
    expect(decodeLinkPath("my%20note.md")).toBe("my note.md");
  });

  it("非法百分号序列回退原文", () => {
    expect(decodeLinkPath("100%.md")).toBe("100%.md");
    expect(decodeLinkPath("a%2.md")).toBe("a%2.md");
  });
});

describe("splitHref", () => {
  it("剥离 fragment 与 query", () => {
    expect(splitHref("a.md#h1?x=1")).toEqual({ path: "a.md", fragment: "h1" });
    expect(splitHref("a.md?x=1")).toEqual({ path: "a.md", fragment: null });
    expect(splitHref("a.md")).toEqual({ path: "a.md", fragment: null });
  });
});

describe("resolveLinkPath", () => {
  it("同级与 ./ 目标", () => {
    expect(resolveLinkPath("dir/a.md", "target.md")).toBe("dir/target.md");
    expect(resolveLinkPath("dir/a.md", "./target.md")).toBe("dir/target.md");
  });

  it("../ 目标", () => {
    expect(resolveLinkPath("dir/sub/a.md", "../folder/target.md")).toBe(
      "dir/folder/target.md",
    );
    expect(resolveLinkPath("dir/a.md", "../target.md")).toBe("target.md");
  });

  it("中文路径与空格", () => {
    expect(resolveLinkPath("项目/a.md", "../目录/页面.md")).toBe(
      "目录/页面.md",
    );
    expect(resolveLinkPath("a.md", "my note.md")).toBe("my note.md");
  });

  it("URL encoding 目标解码后归一", () => {
    expect(resolveLinkPath("a.md", "%E4%B8%AD%E6%96%87.md")).toBe("中文.md");
    expect(resolveLinkPath("dir/a.md", "my%20note.md")).toBe("dir/my note.md");
  });

  it("fragment 不参与路径归一", () => {
    expect(resolveLinkPath("dir/a.md", "target.md#heading")).toBe(
      "dir/target.md",
    );
  });

  it("重复标题：同名文件按路径区分，互不串扰", () => {
    expect(resolveLinkPath("项目A/note.md", "./README.md")).toBe(
      "项目A/README.md",
    );
    expect(resolveLinkPath("项目B/note.md", "./README.md")).toBe(
      "项目B/README.md",
    );
    expect(resolveLinkPath("项目A/note.md", "../项目B/README.md")).toBe(
      "项目B/README.md",
    );
  });

  it("外部 / mailto / 纯锚点 → null（不做路径归一）", () => {
    expect(resolveLinkPath("a.md", "https://example.com/x.md")).toBeNull();
    expect(resolveLinkPath("a.md", "mailto:a@b.com")).toBeNull();
    expect(resolveLinkPath("a.md", "#anchor")).toBeNull();
  });

  it(".. 越过 vault 根 → null（逃逸，索引层按 broken 处理）", () => {
    expect(resolveLinkPath("a.md", "../outside.md")).toBeNull();
    expect(resolveLinkPath("dir/a.md", "../../outside.md")).toBeNull();
    expect(resolveLinkPath("a.md", "../../../../etc/passwd.md")).toBeNull();
  });

  it("asset 目标同样归一（供附件引用统计）", () => {
    expect(resolveLinkPath("dir/a.md", "../assets/design.pdf")).toBe(
      "assets/design.pdf",
    );
  });
});
