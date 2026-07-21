import { describe, expect, it } from "vitest";
import { jsonToText } from "./markdown";
import { DOC_TEMPLATES } from "./templates";

describe("内置模板", () => {
  it("提供首批六个模板", () => {
    expect(DOC_TEMPLATES.map((t) => t.id)).toEqual([
      "blank",
      "meeting",
      "weekly",
      "project-plan",
      "tech-design",
      "reading-notes",
    ]);
    for (const template of DOC_TEMPLATES) {
      expect(template.name).toBeTruthy();
      expect(template.purpose).toBeTruthy();
    }
  });

  it("正文为合法 Tiptap doc JSON，非空模板可提取文本", () => {
    for (const template of DOC_TEMPLATES) {
      const content = template.content as { type: string; content?: unknown[] };
      expect(content.type).toBe("doc");
      expect(Array.isArray(content.content)).toBe(true);
      if (template.id !== "blank") {
        expect(jsonToText(template.content).length).toBeGreaterThan(0);
      }
    }
  });
});
