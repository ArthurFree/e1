import { useState } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import { openAIAssistant } from "../../editor/aiBridge";
import type { AIMode } from "../../domain/ai";

const TEXT_COLORS = [
  { name: "默认", value: null },
  { name: "灰色", value: "#787774" },
  { name: "棕色", value: "#9F6B53" },
  { name: "橙色", value: "#D9730D" },
  { name: "黄色", value: "#CB912F" },
  { name: "绿色", value: "#448361" },
  { name: "蓝色", value: "#337EA9" },
  { name: "紫色", value: "#9065B0" },
  { name: "粉色", value: "#C14C8A" },
  { name: "红色", value: "#D44C47" },
];

const HIGHLIGHT_COLORS = [
  { name: "默认", value: null },
  { name: "灰底", value: "#F1F1EF" },
  { name: "棕底", value: "#F3EEEE" },
  { name: "橙底", value: "#FAEBDD" },
  { name: "黄底", value: "#FBF3DB" },
  { name: "绿底", value: "#EDF3EC" },
  { name: "蓝底", value: "#E7F3F8" },
  { name: "紫底", value: "#F6F3F9" },
  { name: "粉底", value: "#FAF1F5" },
  { name: "红底", value: "#FDEBEC" },
];

interface BubbleToolbarProps {
  editor: Editor;
}

const AI_ACTIONS: { mode: AIMode; label: string }[] = [
  { mode: "polish", label: "润色" },
  { mode: "rewrite", label: "改写" },
  { mode: "summarize", label: "总结" },
];

/** 文本选区浮动工具栏：行内格式、链接、颜色、高亮、AI 选区操作。 */
export function BubbleToolbar({ editor }: BubbleToolbarProps) {
  const [panel, setPanel] = useState<"none" | "link" | "color" | "highlight" | "ai">("none");
  const [linkUrl, setLinkUrl] = useState("");

  const openAI = (mode: AIMode) => {
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    openAIAssistant({
      mode,
      selection: editor.state.doc.textBetween(from, to, "\n"),
      from,
      to,
    });
    setPanel("none");
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
    }
    setPanel("none");
    setLinkUrl("");
  };

  const formatButtons: {
    id: string;
    label: string;
    icon: string;
    active: boolean;
    run(): void;
  }[] = [
    { id: "bold", label: "加粗", icon: "B", active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run() },
    { id: "italic", label: "斜体", icon: "I", active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run() },
    { id: "underline", label: "下划线", icon: "U", active: editor.isActive("underline"), run: () => editor.chain().focus().toggleUnderline().run() },
    { id: "strike", label: "删除线", icon: "S", active: editor.isActive("strike"), run: () => editor.chain().focus().toggleStrike().run() },
    { id: "code", label: "行内代码", icon: "</>", active: editor.isActive("code"), run: () => editor.chain().focus().toggleCode().run() },
  ];

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, state }) =>
        !state.selection.empty && !e.isActive("image") && !e.isActive("table")
      }
    >
      <div className="bubble-toolbar" role="toolbar" aria-label="文本格式">
        {formatButtons.map((btn) => (
          <button
            key={btn.id}
            type="button"
            aria-label={btn.label}
            aria-pressed={btn.active}
            title={btn.label}
            className={`bubble-toolbar__button${btn.active ? " bubble-toolbar__button--active" : ""}`}
            onClick={btn.run}
          >
            {btn.icon}
          </button>
        ))}

        <button
          type="button"
          aria-label="链接"
          title="链接"
          aria-pressed={editor.isActive("link")}
          className={`bubble-toolbar__button${editor.isActive("link") ? " bubble-toolbar__button--active" : ""}`}
          onClick={() => {
            setLinkUrl((editor.getAttributes("link").href as string) ?? "");
            setPanel(panel === "link" ? "none" : "link");
          }}
        >
          🔗
        </button>
        <button
          type="button"
          aria-label="文本颜色"
          title="文本颜色"
          className="bubble-toolbar__button"
          onClick={() => setPanel(panel === "color" ? "none" : "color")}
        >
          A
        </button>
        <button
          type="button"
          aria-label="高亮"
          title="高亮"
          className="bubble-toolbar__button"
          onClick={() => setPanel(panel === "highlight" ? "none" : "highlight")}
        >
          🖊
        </button>

        <button
          type="button"
          aria-label="AI"
          title="AI（润色 / 改写 / 总结）"
          className="bubble-toolbar__button"
          onClick={() => setPanel(panel === "ai" ? "none" : "ai")}
        >
          ✨
        </button>

        {panel === "ai" && (
          <div className="bubble-toolbar__panel" role="menu" aria-label="AI 选区操作">
            {AI_ACTIONS.map((action) => (
              <button
                key={action.mode}
                type="button"
                role="menuitem"
                className="bubble-toolbar__swatch"
                onClick={() => openAI(action.mode)}
              >
                {action.label}选区
              </button>
            ))}
          </div>
        )}

        {panel === "link" && (
          <div className="bubble-toolbar__panel">
            <input
              className="bubble-toolbar__input"
              aria-label="链接地址"
              placeholder="粘贴链接，回车确认"
              value={linkUrl}
              autoFocus
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyLink();
                if (e.key === "Escape") setPanel("none");
              }}
            />
          </div>
        )}

        {panel === "color" && (
          <div className="bubble-toolbar__panel bubble-toolbar__palette" role="menu" aria-label="文本颜色">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                role="menuitem"
                className="bubble-toolbar__swatch"
                aria-label={`文本颜色：${c.name}`}
                onClick={() => {
                  if (c.value) editor.chain().focus().setColor(c.value).run();
                  else editor.chain().focus().unsetColor().run();
                  setPanel("none");
                }}
              >
                <span style={{ color: c.value ?? "var(--text-primary)" }}>A</span>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        )}

        {panel === "highlight" && (
          <div className="bubble-toolbar__panel bubble-toolbar__palette" role="menu" aria-label="高亮颜色">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                role="menuitem"
                className="bubble-toolbar__swatch"
                aria-label={`高亮：${c.name}`}
                onClick={() => {
                  if (c.value)
                    editor.chain().focus().setHighlight({ color: c.value }).run();
                  else editor.chain().focus().unsetHighlight().run();
                  setPanel("none");
                }}
              >
                <span
                  style={{
                    background: c.value ?? "transparent",
                    border: "1px solid var(--border-strong)",
                    borderRadius: 3,
                    padding: "0 4px",
                  }}
                >
                  A
                </span>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </BubbleMenu>
  );
}
