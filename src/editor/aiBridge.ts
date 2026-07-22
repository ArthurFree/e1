import type { AIMode } from "../domain/ai";

/**
 * AI 助手面板的打开桥接（编辑器内核 → React 层的单向事件总线）。
 * `/` 命令注册表（commands.ts）与浮动工具栏运行在非 React 上下文，不持有组件状态，
 * 通过这里的轻量发布/订阅通知 DocumentEditor 挂载的 AIAssistantPanel 打开，
 * 避免编辑器内核反向依赖 React 状态。
 */

/** AI 助手打开请求：触发模式、选区快照与应用结果的目标区间。 */
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

/**
 * 广播打开请求。当前仅 DocumentEditor 挂载的面板订阅；
 * 无订阅者（面板尚未挂载的极端时序）时静默丢弃，不报错。
 */
export function openAIAssistant(request: AIAssistantOpen) {
  for (const listener of listeners) listener(request);
}

/**
 * 订阅打开请求。
 * @returns 取消订阅函数；组件卸载时必须调用，避免泄漏与重复触发。
 */
export function onAIAssistantOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
