import type { ReactNode } from "react";

/**
 * @file 系统图标集（R002 §6）：Lucide 风格线性 SVG。
 * 统一 16px 默认尺寸、24 视窗、1.75 描边、stroke="currentColor" 继承文字颜色，
 * aria-hidden（可访问名称由所在按钮的 aria-label 提供）。
 * 系统 UI 一律使用本文件的 SVG 图标；Emoji 仅允许出现在用户自定义的
 * 知识库 / 文档图标上（见 PageIcon）。
 */

interface IconProps {
  /** 图标边长（px），默认 16。 */
  size?: number;
  className?: string;
}

/** 所有图标共用的 SVG 外壳：统一描边与继承色，具体图形由各图标提供 path。 */
function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.8V21h14V9.8" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.5-4.5" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="m6 7 1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </Svg>
);

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconStarFilled = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z"
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);

export const IconExport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V3" />
    <path d="m6 9 6-6 6 6" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const IconSmile = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <path d="M9 9h.01M15 9h.01" />
  </Svg>
);

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </Svg>
);

export const IconTemplate = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
);

export const IconHighlighter = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 11-6 6v3h9l3-3" />
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z" />
  </Svg>
);

export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="19" r="1" />
  </Svg>
);

/* ---------- 以下为图标整改（系统字形清零）新增 ---------- */

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </Svg>
);

export const IconFolderPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 10v6M9 13h6" />
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
  </Svg>
);

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Svg>
);

export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r="1" />
  </Svg>
);

/** 回形针路径：React 图标与非 React 内联 SVG 字符串共用同一份数据。 */
const PAPERCLIP_PATH =
  "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48";

export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d={PAPERCLIP_PATH} />
  </Svg>
);

/**
 * 非 React 环境（Tiptap NodeView 原生 DOM）使用的回形针内联 SVG 字符串；
 * 图形与 IconPaperclip 共用 PAPERCLIP_PATH，避免两份实现漂移。
 */
export function paperclipSvgString(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PAPERCLIP_PATH}"/></svg>`;
}

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

/** 恢复（回收站）：逆时针回旋箭头（rotate-ccw 风格）。 */
export const IconRestore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

/** 版本历史：时钟 + 逆时针回卷（Lucide history 风格），与 IconClock（最近）区分语义。 */
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </Svg>
);

export const IconAlignLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 6H3M15 12H3M17 18H3" />
  </Svg>
);

export const IconAlignCenter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 6H3M17 12H7M19 18H5" />
  </Svg>
);

export const IconAlignRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 6H3M21 12H9M21 18H7" />
  </Svg>
);

export const IconAlignJustify = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

export const IconBold = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />
  </Svg>
);

export const IconItalic = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 4h-9M14 20H5M15 4 9 20" />
  </Svg>
);

export const IconUnderline = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4v6a6 6 0 0 0 12 0V4" />
    <path d="M4 20h16" />
  </Svg>
);

export const IconStrikethrough = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <path d="M14 12a4 4 0 0 1 0 8H6" />
    <path d="M4 12h16" />
  </Svg>
);

export const IconCodeInline = (p: IconProps) => (
  <Svg {...p}>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </Svg>
);

export const IconSuperscript = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 11 8 8" />
    <path d="m4 19 8-8" />
    <path d="M17 7c0-1.7 3-1.7 3 0 0 1.5-3 2-3 3h3" />
  </Svg>
);

export const IconSubscript = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 5 8 8" />
    <path d="m4 13 8-8" />
    <path d="M17 15c0-1.7 3-1.7 3 0 0 1.5-3 2-3 3h3" />
  </Svg>
);

/** 项目列表：图形与 IconList 相同，作为「项目列表」语义别名，避免两份路径漂移。 */
export const IconBulletList = (p: IconProps) => <IconList {...p} />;

export const IconOrderedList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 6h11M10 12h11M10 18h11" />
    <path d="M4 6h1v4M4 10h2" />
    <path d="M6 18H4c0-1 2-1.5 2-2.5S5 14 4 14" />
  </Svg>
);

export const IconTaskList = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="6" height="6" rx="1" />
    <path d="m3 17 2 2 4-4" />
    <path d="M13 6h8M13 12h8M13 18h8" />
  </Svg>
);

export const IconIndent = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 8 4 4-4 4" />
    <path d="M21 6H3M21 12H11M21 18H3" />
  </Svg>
);

export const IconOutdent = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7 8-4 4 4 4" />
    <path d="M21 6H3M21 12H11M21 18H3" />
  </Svg>
);

/** 清除行内格式：字母横杆 + 斜向叉（remove-formatting 风格）。 */
export const IconRemoveFormat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7V4h16v3" />
    <path d="M5 20h6" />
    <path d="M13 4 8 20" />
    <path d="m15 15 5 5" />
    <path d="m20 15-5 5" />
  </Svg>
);

export const IconParagraph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 4v16M17 4v16" />
    <path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />
  </Svg>
);

/** 撤销：左向回旋箭头（undo-2 风格）。 */
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

/** 重做：右向回旋箭头（redo-2 风格）。 */
export const IconRedo = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" />
  </Svg>
);

/** 文本颜色：字母 A + 底部色条（Lucide 无对应图标，按通用画法自绘）。 */
export const IconTextColor = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 16 12 4l7 12" />
    <path d="M7.5 12h9" />
    <path d="M4 20h16" />
  </Svg>
);

/**
 * 页面/知识库图标：用户自定义 Emoji 原样展示（R002 §6 允许），
 * 未设置时按 kind 回退到统一的 SVG 默认图标（文档 / 分组 / 知识库）。
 */
export function PageIcon({
  icon,
  kind,
  size = 16,
}: {
  /** 用户自定义图标（通常为 Emoji）；为空时回退默认 SVG。 */
  icon?: string | null;
  /** 节点类型，决定回退用哪个默认图标。 */
  kind: "document" | "group" | "workspace";
  size?: number;
}) {
  if (icon) {
    return (
      <span aria-hidden="true" style={{ fontSize: size }}>
        {icon}
      </span>
    );
  }
  if (kind === "group") return <IconFolder size={size} />;
  if (kind === "workspace") return <IconBook size={size} />;
  return <IconFile size={size} />;
}
