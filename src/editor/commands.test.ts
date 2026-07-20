import { describe, expect, it } from "vitest";
import { EDITOR_COMMANDS, filterCommands } from "./commands";

describe("filterCommands", () => {
  it("空查询返回全部命令", () => {
    expect(filterCommands("")).toHaveLength(EDITOR_COMMANDS.length);
  });

  it("按标题过滤", () => {
    const result = filterCommands("表格");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("table");
  });

  it("按关键词过滤（拼音/英文）", () => {
    expect(filterCommands("h1")[0]?.id).toBe("heading1");
    expect(filterCommands("todo")[0]?.id).toBe("taskList");
  });

  it("无匹配返回空", () => {
    expect(filterCommands("不存在的命令")).toHaveLength(0);
  });
});
