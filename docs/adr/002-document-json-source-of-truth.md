# ADR 002：文档 JSON 是唯一编辑真相

## 背景

文档正文既需要富文本编辑（Tiptap），又需要搜索、Markdown 导出与版本历史。若多处各自解析 HTML/Markdown，会产生真相分叉。

## 决策

`DocumentContent.contentJson`（Tiptap JSON）是正文的唯一编辑真相；`textSnapshot` 仅用于全局搜索与 Markdown 导出，不参与编辑。

## 原因

- 编辑器读写同一 JSON，避免 HTML/Markdown 双向转换的信息丢失；
- 搜索索引、版本历史、AI 草稿都围绕同一数据形态工作；
- 内容进入编辑器前经白名单运行时校验（`parseDocumentContent`），损坏数据不会导致编辑器白屏。

## 结果

- 任何写正文的路径（编辑保存、模板、AI、Markdown 导入、版本恢复）最终都落到 contentJson；
- 被否决的替代方案：HTML 为主存储（注入风险与解析分叉）、Markdown 为主存储（表格/附件等块无法无损表达）。
