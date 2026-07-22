/**
 * AI 助手面板（对话框）。
 *
 * 由 `/` 菜单「AI 助手」或选区浮动工具栏触发（经 editor/aiBridge 事件桥），
 * 支持 ask（自由提问）、polish / rewrite / summarize（选区操作）等模式。
 * 未配置 AI 时只展示引导并跳转设置，不发起任何外部请求；
 * 生成结果先预览，用户点「应用」后经 Markdown 白名单解析才写入文档
 * （AGENTS.md 安全要求：AI 输出须经用户确认后才写入文档）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { useApp } from "../../state/AppState";
import { isAIConfigured, type AIMode } from "../../domain/ai";
import { createOpenAICompatibleProvider } from "../../infrastructure/aiProvider";
import { markdownToJson } from "../../editor/markdown";
import { Dialog } from "../ui/Dialog";
import {
  onAIAssistantOpen,
  type AIAssistantOpen,
} from "../../editor/aiBridge";

/** AIAssistantPanel 入参。 */
interface AIAssistantPanelProps {
  /** 目标编辑器；「应用」时向其写入解析后的内容，ask 模式从其读取上下文。 */
  editor: Editor;
}

/** 面板状态机：input 等待输入/自动请求前 → loading 请求中 → done 待确认 / error 失败。 */
type Status = "input" | "loading" | "done" | "error";

/** 各模式对话框标题。 */
const MODE_TITLE: Record<AIMode, string> = {
  ask: "AI 助手",
  polish: "润色选区",
  rewrite: "改写选区",
  summarize: "总结选区",
  draft: "AI 写作",
};

/** ask / summarize 把结果插到目标位置之后；polish / rewrite 替换原选区。 */
const REPLACE_MODES: ReadonlySet<AIMode> = new Set(["polish", "rewrite"]);

/**
 * AI 助手面板：由 `/` 命令或浮动工具栏触发。
 * 结果先预览，经用户确认「应用」后才写入文档（经编辑器白名单解析）。
 */
export function AIAssistantPanel({ editor }: AIAssistantPanelProps) {
  const { preferences, openSettings } = useApp();
  const configured = isAIConfigured(preferences.aiConfig);

  const [request, setRequest] = useState<AIAssistantOpen | null>(null);
  const [status, setStatus] = useState<Status>("input");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  // 记录最近一次请求参数，供「重试 / 重新生成」复用。
  const lastRun = useRef<{ request: AIAssistantOpen; prompt: string } | null>(null);

  const run = useCallback(
    async (req: AIAssistantOpen, userPrompt: string) => {
      const config = preferences.aiConfig;
      if (!isAIConfigured(config) || config === null) return;
      lastRun.current = { request: req, prompt: userPrompt };
      setStatus("loading");
      setError("");
      try {
        const provider = createOpenAICompatibleProvider(config);
        const text = await provider.complete({
          mode: req.mode,
          prompt: userPrompt,
          selection: req.selection,
          // ask 模式附带全文前 2000 字作上下文，兼顾效果与请求体大小。
          documentContext:
            req.mode === "ask" ? editor.getText().slice(0, 2000) : undefined,
        });
        setResult(text);
        setStatus("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "AI 请求失败，请稍后再试");
        setStatus("error");
      }
    },
    [editor, preferences.aiConfig],
  );

  const close = useCallback(() => {
    setRequest(null);
    setStatus("input");
    setPrompt("");
    setResult("");
    setError("");
  }, []);

  useEffect(
    () =>
      onAIAssistantOpen((req) => {
        setRequest(req);
        setPrompt("");
        setResult("");
        setError("");
        setStatus("input");
      }),
    [],
  );

  // 选区模式（润色/改写/总结）打开即请求；等待 preferences 加载完成后再发。
  useEffect(() => {
    if (!request || request.mode === "ask" || status !== "input" || !configured) return;
    void run(request, "");
  }, [request, status, configured, run]);

  if (!request) return null;

  const apply = () => {
    let content: JSONContent[];
    try {
      const parsed = markdownToJson(result) as JSONContent;
      content = parsed.content ?? [];
    } catch {
      setError("AI 返回内容无法解析，请重试");
      setStatus("error");
      return;
    }
    const size = editor.state.doc.content.size;
    // 请求期间文档可能已被编辑，把目标位置钳制到当前文档范围内，避免越界。
    const from = Math.min(request.from, size);
    const to = Math.min(request.to, size);
    if (REPLACE_MODES.has(request.mode)) {
      editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, content).run();
    } else {
      editor.chain().focus().insertContentAt(to, content).run();
    }
    close();
  };

  const retry = () => {
    if (lastRun.current) void run(lastRun.current.request, lastRun.current.prompt);
  };

  return (
    <Dialog label={MODE_TITLE[request.mode]} className="ai-panel" onClose={close}>
        <div className="dialog__header">
          <span>{MODE_TITLE[request.mode]}</span>
        </div>

        {!configured ? (
          <div className="ai-panel__hint">
            <p>尚未配置 AI 服务，配置后即可使用。</p>
            <button
              type="button"
              className="ai-panel__primary"
              onClick={() => {
                close();
                openSettings();
              }}
            >
              打开设置
            </button>
          </div>
        ) : (
          <>
            {request.selection && (
              <blockquote className="ai-panel__selection">{request.selection}</blockquote>
            )}

            {request.mode === "ask" && status === "input" && (
              <div className="ai-panel__ask">
                <textarea
                  className="ai-panel__prompt"
                  aria-label="向 AI 提问"
                  placeholder="输入问题，回车发送（Shift+回车换行）"
                  rows={3}
                  value={prompt}
                  autoFocus
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (prompt.trim()) void run(request, prompt.trim());
                    }
                  }}
                />
                <div className="ai-panel__actions">
                  <button
                    type="button"
                    className="ai-panel__primary"
                    disabled={!prompt.trim()}
                    onClick={() => void run(request, prompt.trim())}
                  >
                    发送
                  </button>
                  <button type="button" onClick={close}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {status === "loading" && (
              <div className="ai-panel__loading">正在请求 AI…</div>
            )}

            {status === "done" && (
              <>
                <div className="ai-panel__preview" aria-label="AI 生成结果预览">
                  {result}
                </div>
                <div className="ai-panel__actions">
                  <button type="button" className="ai-panel__primary" onClick={apply}>
                    应用
                  </button>
                  <button type="button" onClick={retry}>
                    重新生成
                  </button>
                  <button type="button" onClick={close}>
                    取消
                  </button>
                </div>
              </>
            )}

            {status === "error" && (
              <>
                <div className="ai-panel__error">{error}</div>
                <div className="ai-panel__actions">
                  <button type="button" className="ai-panel__primary" onClick={retry}>
                    重试
                  </button>
                  <button type="button" onClick={close}>
                    取消
                  </button>
                </div>
              </>
            )}
          </>
        )}
    </Dialog>
  );
}
