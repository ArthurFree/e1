/**
 * @file Markdown 兼容性风险详情弹层（R006-C3 FR-20 §28.1，自 MainArea 提取）。
 * 列出打开时检出的不支持语法明细（稳定 kind → 中文标签），
 * Escape / 遮罩关闭由 ui/Dialog 承担。
 */

import type { DocumentOpenResult } from "../../application/queries/DocumentQueryService";
import { Dialog } from "../ui/Dialog";

/** Markdown 不支持语法的稳定 kind → 中文标签。 */
const UNSUPPORTED_KIND_LABELS: Record<string, string> = {
  "wiki-link": "Wiki 链接",
  "raw-html": "原始 HTML",
  footnote: "脚注",
  "image-data-uri": "内嵌图片（Data URI）",
  mention: "@ 提及",
  "local-image": "本地图片",
  attachment: "附件",
  "text-style": "文本样式",
  subscript: "下标",
  superscript: "上标",
  "text-align": "对齐方式",
  indent: "缩进",
  "table-cell-content": "表格单元格内容",
  "local-image-width": "图片宽度",
};

export function CompatibilityDetailDialog({
  compatibility,
  onClose,
}: {
  compatibility: DocumentOpenResult["compatibility"];
  onClose(): void;
}) {
  return (
    <Dialog
      label="兼容性风险详情"
      onClose={onClose}
      className="compatibility-dialog"
    >
      <h2 className="compatibility-dialog__title">检测到以下兼容性风险：</h2>
      <ul className="compatibility-dialog__list">
        {compatibility.unsupported.map((feature, index) => (
          <li key={index} className="compatibility-dialog__item">
            <span className="compatibility-dialog__kind">
              {UNSUPPORTED_KIND_LABELS[feature.kind] ?? feature.kind}
            </span>
            {feature.snippet && <code>{feature.snippet}</code>}
            <p className="compatibility-dialog__message">{feature.message}</p>
          </li>
        ))}
      </ul>
      <p className="compatibility-dialog__footnote">
        当前版本不会自动保存这些内容。
      </p>
    </Dialog>
  );
}
