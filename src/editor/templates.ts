/**
 * 内置本地模板（模板中心的数据源，R001 阶段 3「分组、收藏、模板与 AI 快速创建」）。
 * 静态 Tiptap JSON 随应用发布，不访问网络。
 * 从模板创建即复制该 JSON 为普通文档正文，创建后与原模板无关联。
 */

export interface DocTemplate {
  /** 稳定标识，模板卡片与测试引用用。 */
  id: string;
  /** 模板名，展示在模板卡片标题。 */
  name: string;
  /** 用途说明，展示在模板卡片上。 */
  purpose: string;
  /** 内容预览摘要。 */
  preview: string;
  /** 模板正文（Tiptap doc JSON）。 */
  content: unknown;
}

type Json = Record<string, unknown>;

/** 以下 doc/heading/paragraph/bulletList/taskList 是模板 JSON 的构造助手，
 * 只为让下方模板声明保持紧凑可读，不对外导出。 */
const doc = (...content: Json[]): Json => ({ type: "doc", content });
const heading = (level: number, text: string): Json => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const paragraph = (text = ""): Json =>
  text === ""
    ? { type: "paragraph" }
    : { type: "paragraph", content: [{ type: "text", text }] };
const bulletList = (...items: string[]): Json => ({
  type: "bulletList",
  content: items.map((text) => ({
    type: "listItem",
    content: [paragraph(text)],
  })),
});
const taskList = (...items: string[]): Json => ({
  type: "taskList",
  content: items.map((text) => ({
    type: "taskItem",
    attrs: { checked: false },
    content: [paragraph(text)],
  })),
});

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    name: "空白文档",
    purpose: "从一张白纸开始自由书写",
    preview: "无预设内容",
    content: doc(paragraph()),
  },
  {
    id: "meeting",
    name: "会议纪要",
    purpose: "记录会议议题、结论与待办",
    preview: "议题 / 结论 / 待办事项 / 下次会议",
    content: doc(
      heading(1, "会议纪要"),
      paragraph("时间：　　地点：　　参会人："),
      heading(2, "议题"),
      bulletList("议题一", "议题二"),
      heading(2, "结论"),
      bulletList("待补充"),
      heading(2, "待办事项"),
      taskList("负责人：事项（截止时间）"),
      heading(2, "下次会议"),
      paragraph("时间待定"),
    ),
  },
  {
    id: "weekly",
    name: "周报",
    purpose: "汇总本周进展、问题与下周计划",
    preview: "本周进展 / 问题与风险 / 下周计划",
    content: doc(
      heading(1, "周报"),
      paragraph("周期：　　姓名："),
      heading(2, "本周进展"),
      bulletList("完成事项一", "完成事项二"),
      heading(2, "问题与风险"),
      bulletList("待补充"),
      heading(2, "下周计划"),
      taskList("计划事项一", "计划事项二"),
    ),
  },
  {
    id: "project-plan",
    name: "项目计划",
    purpose: "拆解目标、里程碑与分工",
    preview: "背景与目标 / 里程碑 / 分工 / 风险",
    content: doc(
      heading(1, "项目计划"),
      heading(2, "背景与目标"),
      paragraph("一句话说明项目要达成什么。"),
      heading(2, "里程碑"),
      taskList("M1：范围确认（日期）", "M2：开发完成（日期）", "M3：发布（日期）"),
      heading(2, "分工"),
      bulletList("负责人：职责"),
      heading(2, "风险与依赖"),
      bulletList("待补充"),
    ),
  },
  {
    id: "tech-design",
    name: "技术方案",
    purpose: "记录设计背景、方案对比与决策",
    preview: "背景 / 方案对比 / 决策 / 影响面",
    content: doc(
      heading(1, "技术方案"),
      heading(2, "背景"),
      paragraph("要解决的问题与约束。"),
      heading(2, "方案对比"),
      bulletList("方案 A：优劣", "方案 B：优劣"),
      heading(2, "决策"),
      paragraph("选择的方案与理由。"),
      heading(2, "影响面与回滚"),
      bulletList("影响范围", "回滚方式"),
    ),
  },
  {
    id: "reading-notes",
    name: "读书笔记",
    purpose: "摘录要点并记录自己的想法",
    preview: "书目信息 / 要点摘录 / 我的想法",
    content: doc(
      heading(1, "读书笔记"),
      paragraph("书名：　　作者：　　阅读日期："),
      heading(2, "要点摘录"),
      bulletList("摘录一", "摘录二"),
      heading(2, "我的想法"),
      paragraph("记录启发、质疑与可迁移的做法。"),
    ),
  },
];
