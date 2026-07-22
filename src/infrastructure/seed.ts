import type { IDBPDatabase } from "idb";
import type { DocumentContent, Page, Workspace } from "../domain/types";
import { createId } from "./id";
import { STORE_CONTENTS, STORE_PAGES, STORE_WORKSPACES } from "./db";

function text(value: string) {
  return { type: "text", text: value };
}

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

function heading(level: number, value: string) {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}

function taskItem(label: string, checked: boolean) {
  return {
    type: "taskItem",
    attrs: { checked },
    content: [paragraph(text(label))],
  };
}

function tableRow(cells: string[], header: boolean) {
  return {
    type: "tableRow",
    content: cells.map((cell) => ({
      type: header ? "tableHeader" : "tableCell",
      content: [paragraph(text(cell))],
    })),
  };
}

/** 预置欢迎文档：覆盖欢迎信息、引用（提示块）、代码块、任务清单、表格、列表与分隔线。 */
function buildWelcomeDoc() {
  return {
    type: "doc",
    content: [
      heading(1, "欢迎使用 Notion-like Web"),
      paragraph(
        text("这是一个"),
        { type: "text", marks: [{ type: "bold" }], text: "本地优先" },
        text("的笔记应用。所有数据保存在浏览器 IndexedDB 中，离线也能编辑，刷新后内容不丢失。"),
      ),
      {
        type: "blockquote",
        content: [
          paragraph(
            text("提示：在空行键入 "),
            { type: "text", marks: [{ type: "code" }], text: "/" },
            text(" 打开命令菜单；选中文本可唤出浮动工具栏；输入 @ 可以提及其他页面。"),
          ),
        ],
      },
      heading(2, "开始上手"),
      {
        type: "taskList",
        content: [
          taskItem("在左侧页面树新建或重命名文档", true),
          taskItem("用 / 命令插入表格、代码块和公式", false),
          taskItem("试试右上角切换深浅色主题", false),
          taskItem("用 @ 提及另一篇文档", false),
        ],
      },
      heading(2, "支持的内容"),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("标题、引用、代码块、分隔线"))] },
          { type: "listItem", content: [paragraph(text("项目列表、编号列表、待办列表"))] },
          { type: "listItem", content: [paragraph(text("表格、图片、链接、颜色与高亮"))] },
          { type: "listItem", content: [paragraph(text("数学公式与 @ 提及"))] },
        ],
      },
      heading(3, "示例表格"),
      {
        type: "table",
        content: [
          tableRow(["功能", "状态", "说明"], true),
          tableRow(["离线编辑", "可用", "数据保存在浏览器本地"], false),
          tableRow(["命令菜单", "可用", "键入 / 触发"], false),
          tableRow(["AI 助手", "需配置", "在设置页配置后使用"], false),
        ],
      },
      heading(3, "示例代码"),
      {
        type: "codeBlock",
        attrs: { language: null },
        content: [text('function hello() {\n  console.log("你好，世界！");\n}')],
      },
      { type: "horizontalRule" },
      paragraph(text("从这里开始，写下你的第一条笔记吧。")),
    ],
  };
}

const WELCOME_TEXT =
  "欢迎使用 Notion-like Web 这是一个本地优先的笔记应用。所有数据保存在浏览器 IndexedDB 中，离线也能编辑，刷新后内容不丢失。 " +
  "提示：在空行键入 / 打开命令菜单；选中文本可唤出浮动工具栏；输入 @ 可以提及其他页面。 " +
  "开始上手 在左侧页面树新建或重命名文档 用 / 命令插入表格、代码块和公式 试试右上角切换深浅色主题 用 @ 提及另一篇文档 " +
  "支持的内容 标题、引用、代码块、分隔线 项目列表、编号列表、待办列表 表格、图片、链接、颜色与高亮 数学公式与 @ 提及 " +
  "示例表格 功能 状态 说明 离线编辑 可用 数据保存在浏览器本地 命令菜单 可用 键入 / 触发 AI 助手 需配置 在设置页配置后使用 " +
  '示例代码 function hello() { console.log("你好，世界！"); } 从这里开始，写下你的第一条笔记吧。';

interface SeedPage {
  page: Page;
  contentJson: unknown;
  text: string;
}

/** 首次启动写入的预置知识库；全部为简体中文。 */
export async function ensureSeeded(db: IDBPDatabase): Promise<void> {
  // 并发调用共享同一次种子写入：首次渲染时多个仓储方法可能同时触发，
  // 检查-写入不是原子的，不去重会写入重复知识库。
  seedingPromise ??= doSeed(db).finally(() => {
    seedingPromise = null;
  });
  return seedingPromise;
}

let seedingPromise: Promise<void> | null = null;

async function doSeed(db: IDBPDatabase): Promise<void> {
  let workspaceCount = 0;
  try {
    workspaceCount = await db.count(STORE_WORKSPACES);
  } catch {
    workspaceCount = 0;
  }
  if (workspaceCount > 0) return;

  const now = Date.now();
  const workspace: Workspace = {
    id: createId(),
    name: "我的知识库",
    icon: "📚",
    description: "",
    homePageId: null,
    favoriteAt: null,
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const welcome: SeedPage = {
    page: {
      id: createId(),
      workspaceId: workspace.id,
      parentId: null,
      kind: "document",
      title: "欢迎使用 Notion-like Web",
      icon: "👋",
      position: 0,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    contentJson: buildWelcomeDoc(),
    text: WELCOME_TEXT,
  };
  const todo: SeedPage = {
    page: {
      id: createId(),
      workspaceId: workspace.id,
      parentId: null,
      kind: "document",
      title: "任务清单",
      icon: "✅",
      position: 1,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    contentJson: {
      type: "doc",
      content: [
        heading(1, "任务清单"),
        {
          type: "taskList",
          content: [
            taskItem("熟悉页面树的新建与重命名", true),
            taskItem("试试深浅色主题切换", false),
            taskItem("拖动侧栏调整宽度", false),
          ],
        },
      ],
    },
    text: "任务清单 熟悉页面树的新建与重命名 试试深浅色主题切换 拖动侧栏调整宽度",
  };
  const group: SeedPage = {
    page: {
      id: createId(),
      workspaceId: workspace.id,
      parentId: null,
      kind: "group",
      title: "产品资料",
      icon: "📁",
      position: 2,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    contentJson: null,
    text: "",
  };
  const meeting: SeedPage = {
    page: {
      id: createId(),
      workspaceId: workspace.id,
      parentId: group.page.id,
      kind: "document",
      title: "会议纪要示例",
      icon: null,
      position: 0,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    contentJson: {
      type: "doc",
      content: [
        heading(1, "会议纪要示例"),
        paragraph(text("这里是一个分组内的文档，用于演示树形结构。")),
      ],
    },
    text: "会议纪要示例 这里是一个分组内的文档，用于演示树形结构。",
  };

  const tx = db.transaction([STORE_WORKSPACES, STORE_PAGES, STORE_CONTENTS], "readwrite");
  await tx.objectStore(STORE_WORKSPACES).put(workspace);
  for (const { page, contentJson, text: snapshot } of [welcome, todo, group, meeting]) {
    await tx.objectStore(STORE_PAGES).put(page);
    if (page.kind === "document") {
      const content: DocumentContent = {
        pageId: page.id,
        contentJson,
        textSnapshot: snapshot,
        updatedAt: now,
      };
      await tx.objectStore(STORE_CONTENTS).put(content);
    }
  }
  await tx.done;
}
