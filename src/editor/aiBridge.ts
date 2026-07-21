import type { AIMode } from "../domain/ai";

/**
 * AI 助手面板的打开桥接：`/` 命令注册表与浮动工具栏都不持有 React 状态，
 * 通过这里的轻量事件通知 DocumentEditor 挂载的面板打开。
 */

export interface AIAssistantOpen {
  mode: AIMode;
  /** 触发时的选区文字（润色/改写/总结）。 */
  selection?: string;
  /** 应用结果时的目标区间（替换或在其末尾插入），为编辑器文档位置。 */
  from: number;
  to: number;
}

type Listener = (request: AIAssistantOpen) => void;

const listeners = new Set<Listener>();

export function openAIAssistant(request: AIAssistantOpen) {
  for (const listener of listeners) listener(request);
}

export function onAIAssistantOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
