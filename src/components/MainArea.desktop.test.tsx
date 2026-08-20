/**
 * MainArea Desktop 打开/保存链路组件测试（R006-C3/C4）：
 * mock 桌面桥（E1DesktopAPI）+ createDesktopRuntime 真实装配，验证——
 * - 打开 Markdown 显示正文（FR-15）；
 * - lossy Markdown 出现兼容性警告条且默认只读（FR-19/20/21）；
 * - 「允许本次编辑」后可编辑（FR-20 §28.2，仅当前会话）；
 * - NOTE_NOT_FOUND / DOCUMENT_TOO_LARGE 统一错误块（§36.3，FR-23/17）；
 * - C4-E：documentPersistence=true 时创建保存协调器并显示保存状态。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { serializeRoute, type AppRoute } from "../domain/route";
import { AppProvider } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import type { AppServices } from "../application/AppServices";
import type {
  E1DesktopAPI,
  ReadNoteResult,
  VaultScanResult,
} from "../platform/desktop/desktopApi";
import { DesktopIpcError } from "../platform/desktop/desktopApi";
import { createDesktopRuntime } from "../platform/desktop/createDesktopRuntime";
import { MainArea } from "./MainArea";

const COMPATIBLE_MARKDOWN = "# React 笔记\n\n这是正文内容";
const LOSSY_MARKDOWN =
  '[[Wiki Link]]\n\n<div class="custom">\nHTML\n</div>\n\n普通文本';

const SCAN: VaultScanResult = {
  vault: { vaultId: "v1", name: "我的笔记" },
  entries: [
    {
      noteId: "01JABC",
      relativePath: "学习/React.md",
      kind: "document",
      title: "React 笔记",
      parentPath: null,
      tags: [],
    },
  ],
};

function noteResult(markdown: string): ReadNoteResult {
  return {
    stableNoteId: "01JABC",
    relativePath: "学习/React.md",
    markdown,
    versionToken: `sha256:${"c".repeat(64)}`,
    source: {
      modifiedAt: 1722580000000,
      sizeBytes: new TextEncoder().encode(markdown).length,
    },
  };
}

/** 构造 mock 桌面桥：一个可访问的最近 Vault + 一条文档扫描条目。 */
function makeApi(overrides: {
  markdown?: string;
  noteRead?: E1DesktopAPI["note"]["read"];
}): E1DesktopAPI {
  return {
    platform: "desktop",
    versions: {},
    vault: {
      selectDirectory: vi.fn(async () => null),
      openRecent: vi.fn(async () => ({
        vaultId: "v1",
        absolutePath: "/tmp/notes",
        name: "我的笔记",
        displayName: "notes",
        createdAt: "2026-08-09T00:00:00.000Z",
        initialized: true,
      })),
      openSelection: vi.fn(async () => {
        throw new Error("unexpected openSelection");
      }),
      listRecent: vi.fn(async () => [
        {
          vaultId: "v1",
          absolutePath: "/tmp/notes",
          displayName: "我的笔记",
          lastOpenedAt: "2026-08-09T10:00:00.000Z",
          accessible: true,
        },
      ]),
      scan: vi.fn(async () => SCAN),
      // R007 阶段 4：回收站读取（缺省空表）。
      listTrash: vi.fn(async () => ({ entries: [] })),
    },
    note: {
      read:
        overrides.noteRead ??
        vi.fn(async () =>
          noteResult(overrides.markdown ?? COMPATIBLE_MARKDOWN),
        ),
      create: vi.fn(),
      save: vi.fn(),
    },
    asset: {
      pick: vi.fn(),
      import: vi.fn(),
      read: vi.fn(),
      resolveUrl: vi.fn(),
    },
    // R007 阶段 3：外部变更事件订阅（测试不推送事件，空订阅即可）。
    events: { subscribeVaultChanges: vi.fn(() => () => {}) },
  } as unknown as E1DesktopAPI;
}

/** 真实 Desktop 装配渲染；返回协调器工厂 spy（FR-22 断言不创建协调器）。 */
function renderDesktopApp(
  api: E1DesktopAPI,
  route: AppRoute = { view: "document", workspaceId: "v1", pageId: "01JABC" },
) {
  // 路由指向 Vault（Desktop 偏好走 localStorage）。
  localStorage.setItem(
    "e1:desktop-preferences",
    JSON.stringify({ lastRoute: serializeRoute(route) }),
  );
  const { services } = createDesktopRuntime(api);
  const coordinatorSpy = vi.fn(services.createSaveCoordinator);
  services.createSaveCoordinator =
    coordinatorSpy as AppServices["createSaveCoordinator"];
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <MainArea />
      </AppProvider>
    </AppServicesProvider>,
  );
  return { services, coordinatorSpy };
}

/** 编辑器 ProseMirror 根元素（contenteditable 反映可编辑状态）。 */
function editorEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor__content .ProseMirror");
}

/** 等待正文出现（打开链路：扫描 → note.read → MarkdownCodec 解析）。 */
async function waitForEditorText(text: string) {
  await waitFor(() => expect(editorEl()?.textContent).toContain(text), {
    timeout: 5000,
  });
}

describe("MainArea Desktop 打开链路（R006-C3 §42）", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("打开 Desktop Markdown → 显示正文（FR-15）", async () => {
    const api = makeApi({});
    renderDesktopApp(api);
    await waitForEditorText("这是正文内容");
    expect(api.note.read).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    // 顶栏标题来自扫描条目。
    expect(document.querySelector(".topbar__title")?.textContent).toBe(
      "React 笔记",
    );
  });

  it("C4-E：documentPersistence=true → 显示保存状态（非技术验证模式）", async () => {
    const { coordinatorSpy } = renderDesktopApp(makeApi({}));
    await waitForEditorText("这是正文内容");
    expect(
      screen.queryByText("技术验证模式 · 当前修改不会写回磁盘"),
    ).toBeNull();
    expect(screen.getByText("已保存")).toBeInTheDocument();
    // 协调器惰性创建：首次编辑才 enqueue；打开瞬间可不创建。
    expect(coordinatorSpy).not.toHaveBeenCalled();
    expect(editorEl()?.getAttribute("contenteditable")).toBe("true");
  });

  it("lossy Markdown → 兼容性警告条且默认只读（FR-19/20/21）", async () => {
    const { coordinatorSpy } = renderDesktopApp(
      makeApi({ markdown: LOSSY_MARKDOWN }),
    );
    await waitForEditorText("普通文本");
    expect(screen.getByText(/暂不完全支持的格式/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看详情" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "允许本次编辑" }),
    ).toBeInTheDocument();
    // 只读禁止项（§29.2）：不可输入、无常驻格式工具栏；
    // 版本历史入口按 operations.revision.read=false 整体隐藏（R007 §8，
    // Desktop 版本历史为空实现，不显示入口让用户误以为有版本功能）。
    expect(editorEl()?.getAttribute("contenteditable")).toBe("false");
    expect(document.querySelector(".format-toolbar")).toBeNull();
    expect(coordinatorSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "版本历史" })).toBeNull();
  });

  it("查看详情 → unsupported 明细弹层，Escape 可关（FR-20 §28.1）", async () => {
    renderDesktopApp(makeApi({ markdown: LOSSY_MARKDOWN }));
    await waitForEditorText("普通文本");
    await act(async () => {
      screen.getByRole("button", { name: "查看详情" }).click();
    });
    expect(
      await screen.findByRole("dialog", { name: "兼容性风险详情" }),
    ).toBeInTheDocument();
    expect(screen.getByText("检测到以下兼容性风险：")).toBeInTheDocument();
    const kinds = [
      ...document.querySelectorAll(".compatibility-dialog__kind"),
    ].map((el) => el.textContent);
    expect(kinds).toContain("Wiki 链接");
    expect(kinds).toContain("原始 HTML");
    expect(
      screen.getByText("当前版本不会自动保存这些内容。"),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("允许本次编辑 → 可以输入；仅当前会话生效（FR-20 §28.2）", async () => {
    const { coordinatorSpy } = renderDesktopApp(
      makeApi({ markdown: LOSSY_MARKDOWN }),
    );
    await waitForEditorText("普通文本");
    await act(async () => {
      screen.getByRole("button", { name: "允许本次编辑" }).click();
    });
    await waitFor(() =>
      expect(editorEl()?.getAttribute("contenteditable")).toBe("true"),
    );
    expect(screen.queryByRole("button", { name: "允许本次编辑" })).toBeNull();
    expect(screen.getByText(/已允许本次编辑/)).toBeInTheDocument();
    // 允许编辑后仍惰性创建协调器（首次编辑才 enqueue）。
    expect(coordinatorSpy).not.toHaveBeenCalled();
  });

  it("NOTE_NOT_FOUND → 「这篇笔记已经不存在」+ 重新扫描按钮（FR-23/§36.3）", async () => {
    const api = makeApi({
      noteRead: vi.fn(async () => {
        throw new DesktopIpcError(
          "NOTE_NOT_FOUND",
          "ENOENT: no such file or directory",
        );
      }),
    });
    renderDesktopApp(api);
    expect(await screen.findByText("这篇笔记已经不存在")).toBeInTheDocument();
    expect(
      screen.getByText("它可能已经被其他程序移动或删除。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新扫描知识库" }),
    ).toBeInTheDocument();
    // 不渲染编辑器，也不展示英文原始 message / Node 栈（§36.3）。
    expect(editorEl()).toBeNull();
    expect(screen.queryByText(/ENOENT/)).toBeNull();
  });

  it("DOCUMENT_TOO_LARGE → 显示实际大小与上限 + 关闭返回知识库首页（FR-17）", async () => {
    const api = makeApi({
      noteRead: vi.fn(async () => {
        throw new DesktopIpcError("DOCUMENT_TOO_LARGE", "file too large", {
          sizeBytes: 11534336,
          maxBytes: 10485760,
        });
      }),
    });
    renderDesktopApp(api);
    expect(await screen.findByText("文件过大，暂无法打开")).toBeInTheDocument();
    expect(screen.getByText(/11\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/10\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(/file too large/)).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "关闭" }).click();
    });
    // 关闭 = 返回知识库首页（WorkspaceHome 显示知识库名称）。
    expect(await screen.findByText("我的笔记")).toBeInTheDocument();
    expect(screen.queryByText("文件过大，暂无法打开")).toBeNull();
  });

  it("NOTE_NOT_FOUND 后点「重新扫描知识库」：缓存失效重扫 + 重试打开（FR-26）", async () => {
    // 首次打开时文件已被外部删除；用户把文件移回后点「重新扫描知识库」。
    let recovered = false;
    const api = makeApi({
      noteRead: vi.fn(async () => {
        if (!recovered) {
          throw new DesktopIpcError("NOTE_NOT_FOUND", "ENOENT");
        }
        return noteResult(COMPATIBLE_MARKDOWN);
      }),
    });
    renderDesktopApp(api);
    expect(await screen.findByText("这篇笔记已经不存在")).toBeInTheDocument();
    const scansBefore = vi.mocked(api.vault.scan).mock.calls.length;

    recovered = true;
    await act(async () => {
      screen.getByRole("button", { name: "重新扫描知识库" }).click();
    });
    // 缓存失效 → 真实重扫一次；页面/标签刷新复用预热快照，正文重试打开。
    await waitForEditorText("这是正文内容");
    expect(api.vault.scan).toHaveBeenCalledTimes(scansBefore + 1);
  });

  it("知识库首页提供「重新扫描」入口并刷新树（FR-26/§36.4）", async () => {
    const api = makeApi({});
    renderDesktopApp(api, { view: "workspace", workspaceId: "v1" });
    const button = await screen.findByRole("button", { name: "重新扫描" });
    const scansBefore = vi.mocked(api.vault.scan).mock.calls.length;
    await act(async () => {
      button.click();
    });
    await waitFor(() =>
      expect(api.vault.scan).toHaveBeenCalledTimes(scansBefore + 1),
    );
    // 扫描后文档仍在目录概览中（树经 refreshCurrentWorkspace 刷新）。
    expect(screen.getByText("React 笔记")).toBeInTheDocument();
  });
});
