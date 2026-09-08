/**
 * R012 Stage 5（需求 §27 Diff）：行级 diff 渲染组件。
 * 输入历史（before）与当前（after）两段纯文本，渲染
 * added/removed/context 三态行；行数过大时 computeLineDiff 返回
 * null，降级为「文档过大，无法比较」提示。
 */
import { useMemo } from "react";
import { computeLineDiff, type RevisionDiffLine } from "./lineDiff";

const GUTTER_MARK: Record<RevisionDiffLine["type"], string> = {
  added: "+",
  removed: "−",
  context: " ",
};

export function RevisionDiff({
  before,
  after,
}: {
  /** 历史版本文本。 */
  before: string;
  /** 当前正文文本。 */
  after: string;
}) {
  const lines = useMemo(() => computeLineDiff(before, after), [before, after]);
  if (lines === null) {
    return <div className="revision-diff__fallback">文档过大，无法比较。</div>;
  }
  return (
    <div className="revision-diff" role="list">
      {lines.map((line, index) => (
        <div
          // 行内容可重复，以序号作 key（diff 结果是一次性快照，不重排）。
          key={index}
          className={`revision-diff__line revision-diff__line--${line.type}`}
          role="listitem"
        >
          <span className="revision-diff__gutter" aria-hidden="true">
            {GUTTER_MARK[line.type]}
          </span>
          <span className="revision-diff__text">
            {/* 空行用不换行空格占位，保持行高。 */}
            {line.text === "" ? "\u00a0" : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}
