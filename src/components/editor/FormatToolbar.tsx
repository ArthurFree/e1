import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { EDITOR_COMMANDS } from "../../editor/commands";
import {
  BLOCK_STYLES,
  FONT_SIZES,
  HIGHLIGHT_COLORS,
  TEXT_COLORS,
  applyHighlight,
  applyTextColor,
  clearInlineFormat,
  currentBlockStyleTitle,
  currentFontSize,
  isBlockStyleActive,
  resetBlockToParagraph,
  setBlockStyle,
  setFontSize,
} from "../../editor/format";
import { EmojiPicker } from "./EmojiPicker";

interface FormatToolbarProps {
  editor: Editor;
}

/** 下拉容器：外部点击与 Escape 关闭，菜单项支持方向键移动焦点。 */
function Dropdown({
  label,
  ariaLabel,
  children,
  className,
}: {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length];
    next.focus();
  };

  return (
    <div className={`ft-dropdown${className ? ` ${className}` : ""}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="ft-dropdown__trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span aria-hidden="true" className="ft-dropdown__caret">▾</span>
      </button>
      {open && (
        <div
          className="ft-dropdown__menu"
          role="menu"
          aria-label={ariaLabel}
          onClick={(event) => {
            // 选择任意菜单项后关闭菜单。
            if ((event.target as HTMLElement).closest("[role='menuitem']")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  active,
  disabled,
  onClick,
  className,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ft-button${active ? " ft-button--active" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** 对齐与缩进按钮组（1024px 以下收进“更多”）。 */
function AlignIndentButtons({ editor }: { editor: Editor }) {
  const aligns = [
    { id: "left", label: "左对齐", icon: "≡" },
    { id: "center", label: "居中对齐", icon: "≣" },
    { id: "right", label: "右对齐", icon: "≡" },
    { id: "justify", label: "两端对齐", icon: "☰" },
  ] as const;
  return (
    <>
      {aligns.map((a) => (
        <ToolbarButton
          key={a.id}
          label={a.label}
          icon={a.icon}
          active={editor.isActive({ textAlign: a.id })}
          onClick={() => editor.chain().focus().setTextAlign(a.id).run()}
        />
      ))}
      <span className="ft-divider" aria-hidden="true" />
      <ToolbarButton
        label="增加缩进"
        icon="⇥"
        onClick={() => editor.chain().focus().indent().run()}
      />
      <ToolbarButton
        label="减少缩进"
        icon="⇤"
        onClick={() => editor.chain().focus().outdent().run()}
      />
    </>
  );
}

/** 清理按钮组（1024px 以下收进“更多”）。 */
function CleanupButtons({ editor }: { editor: Editor }) {
  return (
    <>
      <ToolbarButton
        label="清除行内格式"
        icon="⌫"
        onClick={() => clearInlineFormat(editor)}
      />
      <ToolbarButton
        label="重置为正文"
        icon="¶"
        onClick={() => resetBlockToParagraph(editor)}
      />
    </>
  );
}

/**
 * 常驻格式工具栏：插入、历史、段落样式、字号、行内、链接、颜色、
 * 对齐、列表、缩进、清理。命令执行与 / 菜单、选区工具栏共享 format.ts / commands.ts。
 */
export function FormatToolbar({ editor }: FormatToolbarProps) {
  const [, setTick] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    editor.on("transaction", refresh);
    return () => {
      editor.off("transaction", refresh);
    };
  }, [editor]);

  const runSlashCommand = (id: string) => {
    EDITOR_COMMANDS.find((c) => c.id === id)?.run(editor);
  };

  const inlineMarks = [
    { id: "bold", label: "加粗", icon: "B", run: () => editor.chain().focus().toggleBold().run() },
    { id: "italic", label: "斜体", icon: "I", run: () => editor.chain().focus().toggleItalic().run() },
    { id: "underline", label: "下划线", icon: "U", run: () => editor.chain().focus().toggleUnderline().run() },
    { id: "strike", label: "删除线", icon: "S", run: () => editor.chain().focus().toggleStrike().run() },
    { id: "code", label: "行内代码", icon: "</>", run: () => editor.chain().focus().toggleCode().run() },
    { id: "superscript", label: "上标", icon: "x²", run: () => editor.chain().focus().toggleSuperscript().run() },
    { id: "subscript", label: "下标", icon: "x₂", run: () => editor.chain().focus().toggleSubscript().run() },
  ];

  const lists = [
    { id: "bulletList", label: "项目列表", icon: "•≡", run: () => editor.chain().focus().toggleBulletList().run() },
    { id: "orderedList", label: "编号列表", icon: "1≡", run: () => editor.chain().focus().toggleOrderedList().run() },
    { id: "taskList", label: "任务列表", icon: "☑", run: () => editor.chain().focus().toggleTaskList().run() },
  ];

  const insertItems: { id: string | null; title: string; disabled?: boolean }[] = [
    { id: "divider", title: "分隔线" },
    { id: "image", title: "图片" },
    { id: "attachment", title: "附件" },
    { id: "table", title: "表格" },
    { id: "inlineMath", title: "行内公式" },
    { id: "blockMath", title: "公式块" },
    { id: "askAI", title: "AI 助手" },
  ];

  const fontSize = currentFontSize(editor);

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    setLinkOpen(false);
    setLinkUrl("");
  };

  return (
    <div className="format-toolbar" role="toolbar" aria-label="格式工具栏">
      <Dropdown label="插入" ariaLabel="插入">
        {insertItems.map((item) => (
          <button
            key={item.title}
            type="button"
            role="menuitem"
            className="ft-menuitem"
            disabled={item.disabled}
            onClick={() => item.id && runSlashCommand(item.id)}
          >
            {item.title}
          </button>
        ))}
      </Dropdown>
      <EmojiPicker editor={editor} />

      <span className="ft-divider" aria-hidden="true" />
      <ToolbarButton
        label="撤销"
        icon="↩"
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <ToolbarButton
        label="重做"
        icon="↪"
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      />

      <span className="ft-divider" aria-hidden="true" />
      <Dropdown label={currentBlockStyleTitle(editor)} ariaLabel="段落样式">
        {BLOCK_STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            role="menuitem"
            aria-current={isBlockStyleActive(editor, style.id)}
            className={`ft-menuitem${isBlockStyleActive(editor, style.id) ? " ft-menuitem--active" : ""}`}
            onClick={() => setBlockStyle(editor, style.id)}
          >
            {style.title}
          </button>
        ))}
      </Dropdown>
      <Dropdown label={fontSize === null ? "默认字号" : `${fontSize}px`} ariaLabel="字号">
        <button
          type="button"
          role="menuitem"
          className={`ft-menuitem${fontSize === null ? " ft-menuitem--active" : ""}`}
          onClick={() => setFontSize(editor, null)}
        >
          默认
        </button>
        {FONT_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            role="menuitem"
            className={`ft-menuitem${fontSize === size ? " ft-menuitem--active" : ""}`}
            onClick={() => setFontSize(editor, size)}
          >
            {size}px
          </button>
        ))}
      </Dropdown>

      <span className="ft-divider" aria-hidden="true" />
      {inlineMarks.map((mark) => (
        <ToolbarButton
          key={mark.id}
          label={mark.label}
          icon={mark.icon}
          active={editor.isActive(mark.id)}
          onClick={mark.run}
        />
      ))}

      <span className="ft-divider" aria-hidden="true" />
      <div className="ft-dropdown">
        <ToolbarButton
          label="链接"
          icon="🔗"
          active={editor.isActive("link")}
          onClick={() => {
            setLinkUrl((editor.getAttributes("link").href as string) ?? "");
            setLinkOpen((v) => !v);
          }}
        />
        {linkOpen && (
          <div className="ft-dropdown__menu ft-linkpanel">
            <input
              className="ft-linkpanel__input"
              aria-label="链接地址"
              placeholder="粘贴链接，回车确认；留空移除链接"
              value={linkUrl}
              autoFocus
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyLink();
                if (event.key === "Escape") setLinkOpen(false);
              }}
            />
            <button type="button" className="button" onClick={applyLink}>
              确定
            </button>
          </div>
        )}
      </div>
      <Dropdown label="A" ariaLabel="颜色与高亮">
        <div className="ft-palette__label">文本颜色</div>
        {TEXT_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            role="menuitem"
            className="ft-menuitem"
            aria-label={`文本颜色：${c.name}`}
            onClick={() => applyTextColor(editor, c.value)}
          >
            <span style={{ color: c.value ?? "var(--color-text-primary)" }}>A</span> {c.name}
          </button>
        ))}
        <div className="ft-palette__label">高亮背景</div>
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            role="menuitem"
            className="ft-menuitem"
            aria-label={`高亮：${c.name}`}
            onClick={() => applyHighlight(editor, c.value)}
          >
            <span
              style={{
                background: c.value ?? "transparent",
                border: "1px solid var(--color-border-strong)",
                borderRadius: 3,
                padding: "0 4px",
              }}
            >
              A
            </span>{" "}
            {c.name}
          </button>
        ))}
      </Dropdown>

      <span className="ft-divider" aria-hidden="true" />
      {lists.map((list) => (
        <ToolbarButton
          key={list.id}
          label={list.label}
          icon={list.icon}
          active={editor.isActive(list.id)}
          onClick={list.run}
        />
      ))}

      <span className="ft-divider ft-group--collapsible" aria-hidden="true" />
      <span className="ft-group--collapsible ft-group__inline">
        <AlignIndentButtons editor={editor} />
      </span>
      <span className="ft-divider ft-group--collapsible" aria-hidden="true" />
      <span className="ft-group--collapsible ft-group__inline">
        <CleanupButtons editor={editor} />
      </span>

      <Dropdown label="更多" ariaLabel="更多命令" className="ft-more">
        <div className="ft-palette__label">对齐</div>
        {(
          [
            ["left", "左对齐"],
            ["center", "居中对齐"],
            ["right", "右对齐"],
            ["justify", "两端对齐"],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            className={`ft-menuitem${editor.isActive({ textAlign: id }) ? " ft-menuitem--active" : ""}`}
            onClick={() => editor.chain().focus().setTextAlign(id).run()}
          >
            {title}
          </button>
        ))}
        <div className="ft-palette__label">缩进</div>
        <button
          type="button"
          role="menuitem"
          className="ft-menuitem"
          onClick={() => editor.chain().focus().indent().run()}
        >
          增加缩进
        </button>
        <button
          type="button"
          role="menuitem"
          className="ft-menuitem"
          onClick={() => editor.chain().focus().outdent().run()}
        >
          减少缩进
        </button>
        <div className="ft-palette__label">清理</div>
        <button
          type="button"
          role="menuitem"
          className="ft-menuitem"
          onClick={() => clearInlineFormat(editor)}
        >
          清除行内格式
        </button>
        <button
          type="button"
          role="menuitem"
          className="ft-menuitem"
          onClick={() => resetBlockToParagraph(editor)}
        >
          重置为正文
        </button>
      </Dropdown>
    </div>
  );
}
