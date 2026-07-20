import { describe, expect, it } from "vitest";
import { jsonToMarkdown, markdownToJson } from "./markdown";

interface DocNode {
  type: string;
  content?: DocNode[];
  text?: string;
}

function nodeTypes(doc: DocNode): string[] {
  return (doc.content ?? []).map((n) => n.type);
}

describe("markdownToJson", () => {
  it("解析标题、段落与行内格式", () => {
    const doc = markdownToJson("# 标题\n\n正文 **加粗**") as DocNode;
    expect(doc.type).toBe("doc");
    expect(nodeTypes(doc)).toEqual(["heading", "paragraph"]);
  });

  it("解析任务列表与代码块", () => {
    const doc = markdownToJson("- [ ] 待办\n- [x] 完成\n\n```js\nconst a = 1;\n```") as DocNode;
    expect(nodeTypes(doc)).toEqual(["taskList", "codeBlock"]);
  });

  it("解析表格", () => {
    const doc = markdownToJson("| A | B |\n| - | - |\n| 1 | 2 |") as DocNode;
    expect(nodeTypes(doc)).toContain("table");
  });

  it("无法解析时抛中文错误", () => {
    expect(() => markdownToJson(null as unknown as string)).toThrow(
      "无法解析该 Markdown 文件",
    );
  });
});

describe("jsonToMarkdown", () => {
  it("与导入互逆：标题与正文可还原", () => {
    const source = "# 季度计划\n\n第一段正文。\n\n- 项目一\n- 项目二";
    const json = markdownToJson(source);
    const markdown = jsonToMarkdown(json);
    expect(markdown).toContain("# 季度计划");
    expect(markdown).toContain("第一段正文。");
    expect(markdown).toContain("- 项目一");
  });
});
