/**
 * markdownToSearchText 测试（R008 Stage 3 §10.3）：Markdown → 可检索纯文本
 * 的提取规则冻结。bodyText 是全文搜索唯一正文来源，规则变更须先改测试。
 */
import { describe, expect, it } from "vitest";
import { markdownToSearchText } from "./searchText.js";

describe("markdownToSearchText", () => {
  it("剥离 Frontmatter，元数据不进入正文索引文本", () => {
    const md = [
      "---",
      "id: note-1",
      "title: fm-only-title",
      "tags: [fm-only-tag]",
      "---",
      "",
      "正文内容。",
    ].join("\n");
    const text = markdownToSearchText(md);
    expect(text).toBe("正文内容。");
    expect(text).not.toContain("fm-only-title");
    expect(text).not.toContain("fm-only-tag");
  });

  it("剔除标题/引用/列表/任务标记，保留文本", () => {
    const md = [
      "# 标题文本",
      "",
      "> 引用内容",
      "",
      "- 无序项",
      "1. 有序项",
      "- [x] 已完成任务",
      "- [ ] 待办任务",
    ].join("\n");
    expect(markdownToSearchText(md)).toBe(
      "标题文本 引用内容 无序项 有序项 已完成任务 待办任务",
    );
  });

  it("强调标记剔除，词内下划线与星号保留", () => {
    const md = "**粗体** 与 *斜体* 与 __着重__ 与 ~~删除线~~，snake_case 与 2*3 保留";
    expect(markdownToSearchText(md)).toBe(
      "粗体 与 斜体 与 着重 与 删除线，snake_case 与 2*3 保留",
    );
  });

  it("链接保留锚文本并丢弃 URL，图片保留 alt", () => {
    const md = "见[部署文档](https://example.com/deploy)与![架构图](assets/arch.png)。";
    const text = markdownToSearchText(md);
    expect(text).toBe("见部署文档与架构图。");
    expect(text).not.toContain("https://example.com");
    expect(text).not.toContain("assets/arch.png");
  });

  it("自动链接保留 URL 文本", () => {
    expect(markdownToSearchText("参考 <https://example.com> 与 <mailto:a@b.c>")).toBe(
      "参考 https://example.com 与 mailto:a@b.c",
    );
  });

  it("围栏代码块保留代码文本、剔除围栏与语言标记", () => {
    const md = ["说明：", "", "```ts", "const x = debounce(fn, 200);", "```", ""].join(
      "\n",
    );
    const text = markdownToSearchText(md);
    expect(text).toBe("说明： const x = debounce(fn, 200);");
    expect(text).not.toContain("```");
  });

  it("行内代码保留内容、去反引号", () => {
    expect(markdownToSearchText("使用 `npm run build` 构建。")).toBe(
      "使用 npm run build 构建。",
    );
  });

  it("表格保留单元格文本，剔除管道符与分隔行", () => {
    const md = ["| 名称 | 值 |", "| --- | --- |", "| 甲 | 1 |"].join("\n");
    const text = markdownToSearchText(md);
    expect(text).toBe("名称 值 甲 1");
    expect(text).not.toContain("|");
  });

  it("HTML 标签剔除、文本保留", () => {
    expect(markdownToSearchText("<div>你好</div><br/>世界 <!-- 注释 -->")).toBe(
      "你好 世界",
    );
  });

  it("水平线与 setext 下划线剔除，链接引用定义行剔除", () => {
    const md = ["上文", "", "---", "", "下文", "", "[ref]: https://example.com"].join(
      "\n",
    );
    expect(markdownToSearchText(md)).toBe("上文 下文");
  });

  it("文档中间的 --- 不当作 Frontmatter", () => {
    const md = ["第一段", "", "---", "", "第二段"].join("\n");
    expect(markdownToSearchText(md)).toBe("第一段 第二段");
  });

  it("CRLF 归一处理", () => {
    const md = "---\r\ntitle: x\r\n---\r\n\r\n第一行\r\n第二行\r\n";
    expect(markdownToSearchText(md)).toBe("第一行 第二行");
  });

  it("连续空白与换行归一为单个空格", () => {
    expect(markdownToSearchText("甲   乙\n\n\n丙\t丁")).toBe("甲 乙 丙 丁");
  });

  it("中文与 emoji 原样保留", () => {
    expect(markdownToSearchText("周六出发 🚀，记得带相机 📷")).toBe(
      "周六出发 🚀，记得带相机 📷",
    );
  });

  it("空输入与纯 Frontmatter 文档返回空串", () => {
    expect(markdownToSearchText("")).toBe("");
    expect(markdownToSearchText("---\ntitle: x\n---\n")).toBe("");
  });
});
