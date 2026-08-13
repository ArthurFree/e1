/**
 * @file 文档 Markdown 导出（自 MainArea 提取，行为不变）。
 * 编排由 application 层的 exportDocumentMarkdown 承担；本模块只负责把
 * 结果落成浏览器下载（临时 Blob + 隐藏 a[download]，无需服务端参与）。
 */

import {
  exportDocumentMarkdown,
  type DocumentExportInput,
} from "../../application/markdown/documentExport";

/**
 * 导出当前文档并触发下载。
 * R005 阶段 4B：含图片/附件时产出含资源的 ZIP 包（标题.md + assets/…），
 * 不再静默丢弃资源节点；无资源时维持单 .md 导出（无 Frontmatter）。
 */
export async function exportMarkdownFile(
  input: DocumentExportInput,
): Promise<void> {
  const result = await exportDocumentMarkdown(input);
  // 导出入口暂无 toast 反馈通道：有损转换明细先经 console.warn 暴露，
  // 后续批次有统一通知通道后再接上「本次导出含有损转换」提示。
  if (result.lossy) {
    console.warn(
      `本次导出含有损转换（${result.unsupported.length} 项）：`,
      result.unsupported,
    );
  }
  const blob =
    result.kind === "zip"
      ? new Blob([result.data.buffer as ArrayBuffer], {
          type: "application/zip",
        })
      : new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
