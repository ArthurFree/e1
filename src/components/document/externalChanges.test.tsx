/**
 * 当前文档的外部 Vault 变更策略测试（R007 阶段 3 §3.4）：
 * 以内存容器 + 内存版 externalVaultChanges mock 驱动归一化变更流，验证
 * useDocumentConflict / EditorShell 的四条分支：
 *
 * - clean + modified/moved：自动重载 + 轻量提示「文件已由其他程序更新」；
 * - dirty + modified：不自动重载，复用冲突面板；
 * - clean + deleted：正文区替换为「源文件已删除」错误块
 *   （重新扫描 / 返回知识库）；
 * - dirty + deleted：保留编辑器内存，提示条提供「另存副本」入口；
 * - 无 externalVaultChanges（Web）：不出现任何外部变更 UI。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { serializeRoute } from "../../domain/route";
import type { Page } from "../../domain/types";
import type {
  ExternalDocumentChange,
  ExternalVaultChangeService,
} from "../../application/services/ExternalVaultChangeService";
import {
  createInMemoryAppServices,
  type InMemoryAppServices,
} from "../../infrastructure/memory/createInMemoryAppServices";
import { AppProvider } from "../../state/AppState";
import { AppServicesProvider } from "../../state/AppServicesProvider";
import { MainArea } from "../MainArea";
import { ExternalVaultChangeBridge } from "../shell/ExternalVaultChangeBridge";

const VAULT = "v1";

function docWith(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** 内存版 externalVaultChanges：手动 emit 归一化变更批次。 */
function makeExternalChanges() {
  const listeners = new Set<(changes: ExternalDocumentChange[]) => void>();
  const service: ExternalVaultChangeService = {
    start: () => {},
    stop: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const emit = (changes: ExternalDocumentChange[]) => {
    for (const listener of [...listeners]) listener(changes);
  };
  return { service, emit };
}

function renderMainArea(services: InMemoryAppServices) {
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <MainArea />
      </AppProvider>
    </AppServicesProvider>,
  );
}

/** 含外部变更桥的真实链路渲染（桥要求 fileWatching 能力）。 */
function renderMainAreaWithBridge(services: InMemoryAppServices) {
  services.capabilities = { ...services.capabilities, fileWatching: true };
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <ExternalVaultChangeBridge />
        <MainArea />
      </AppProvider>
    </AppServicesProvider>,
  );
}

/** 预置知识库 + 一篇文档（正文版本令牌 "mem:2"）+ 指向该文档的路由。 */
async function seedWorkspace(services: InMemoryAppServices) {
  const ws = await services.workspace.create("知识库");
  const pageA = await services.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "文档甲",
  });
  await services.content.save(
    pageA.id,
    docWith("初始内容甲"),
    "初始内容甲",
    "mem:1",
  );
  await services.preferences.update({
    lastRoute: serializeRoute({
      view: "document",
      workspaceId: ws.id,
      pageId: pageA.id,
    }),
  });
  return { ws, pageA };
}

interface Fixture {
  services: InMemoryAppServices;
  emit: (changes: ExternalDocumentChange[]) => void;
  rescan: ReturnType<typeof vi.fn>;
  workspaceId: string;
  pageA: Page;
}

/** 渲染并等待文档甲编辑器就绪（clean 状态起点）。 */
async function renderApp(): Promise<Fixture> {
  const { service, emit } = makeExternalChanges();
  const rescan = vi.fn(async () => {});
  const { services } = createInMemoryAppServices();
  const { ws, pageA } = await seedWorkspace(services);
  services.externalVaultChanges = service;
  services.vaultMaintenance = { rescan };
  renderMainArea(services);
  await waitFor(() => expect(editorText()).toContain("初始内容甲"), {
    timeout: 5000,
  });
  return { services, emit, rescan, workspaceId: ws.id, pageA };
}

/**
 * dirty 状态起点（沿用 MainArea.sync.test.tsx 的门控手法）：
 * 恢复缓冲比磁盘正文新，应用后首次保存被门控挂起，形成本地 dirty 窗口。
 */
async function renderDirtyApp(
  localText: string,
): Promise<Fixture & { releaseSave(): void }> {
  const { service, emit } = makeExternalChanges();
  const rescan = vi.fn(async () => {});
  const { services } = createInMemoryAppServices();
  const { ws, pageA } = await seedWorkspace(services);
  services.externalVaultChanges = service;
  services.vaultMaintenance = { rescan };
  await services.recoveryStore.write({
    pageId: pageA.id,
    contentJson: docWith(localText),
    generation: 1,
    timestamp: Date.now() + 10_000,
  });
  renderMainArea(services);
  const applyButton = await screen.findByRole("button", { name: "恢复" });
  const realSave = services.content.save.bind(services.content);
  let release: (() => void) | null = null;
  vi.spyOn(services.content, "save").mockImplementationOnce(
    (pageId, json, text, expectedVersion) =>
      new Promise((resolve, reject) => {
        release = () =>
          realSave(pageId, json, text, expectedVersion).then(resolve, reject);
      }),
  );
  await act(async () => {
    applyButton.click();
  });
  await waitFor(() => expect(editorText()).toContain(localText), {
    timeout: 5000,
  });
  // 本地保存被门控挂起：状态为「保存中」（dirty 窗口）。
  await waitFor(() => expect(screen.getByText("保存中…")).toBeInTheDocument(), {
    timeout: 5000,
  });
  return {
    services,
    emit,
    rescan,
    workspaceId: ws.id,
    pageA,
    releaseSave: () => release?.(),
  };
}

function editorText(): string {
  return document.querySelector(".editor__content")?.textContent ?? "";
}

describe("当前文档的外部 Vault 变更策略（R007 §3.4）", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clean + modified：自动重载正文并显示轻量提示", async () => {
    const { services, emit, pageA } = await renderApp();
    // 外部程序修改了磁盘文件（内存库中直接推进正文模拟）。
    await services.content.save(
      pageA.id,
      docWith("外部新内容"),
      "外部新内容",
      "mem:2",
    );
    await act(async () => {
      emit([{ type: "modified", vaultId: VAULT, pageId: pageA.id }]);
    });
    await waitFor(() => expect(editorText()).toContain("外部新内容"), {
      timeout: 5000,
    });
    expect(
      screen.getByText("文件已由其他程序更新，已自动重新载入。"),
    ).toBeInTheDocument();
    // 无冲突面板。
    expect(document.querySelector(".conflict-banner")).toBeNull();
  });

  it("clean + moved：同样自动重载并提示", async () => {
    const { emit, pageA } = await renderApp();
    await act(async () => {
      emit([
        {
          type: "moved",
          vaultId: VAULT,
          pageId: pageA.id,
          from: "a.md",
          to: "dir/a.md",
        },
      ]);
    });
    await waitFor(() =>
      expect(
        screen.getByText("文件已由其他程序更新，已自动重新载入。"),
      ).toBeInTheDocument(),
    );
  });

  it("dirty + modified：不自动重载，显示冲突面板", async () => {
    const { emit, pageA, releaseSave } = await renderDirtyApp("本地未保存内容");
    await act(async () => {
      emit([{ type: "modified", vaultId: VAULT, pageId: pageA.id }]);
    });
    await waitFor(() =>
      expect(document.querySelector(".conflict-banner")).not.toBeNull(),
    );
    // 编辑器仍是本地内容（未自动重载），无轻量提示。
    expect(editorText()).toContain("本地未保存内容");
    expect(
      screen.queryByText("文件已由其他程序更新，已自动重新载入。"),
    ).toBeNull();
    await act(async () => {
      releaseSave();
    });
  });

  it("clean + deleted：正文区替换为「源文件已删除」错误块", async () => {
    const { emit, rescan, workspaceId, pageA } = await renderApp();
    await act(async () => {
      emit([{ type: "deleted", vaultId: VAULT, pageId: pageA.id }]);
    });
    await waitFor(() =>
      expect(screen.getByText("源文件已被删除")).toBeInTheDocument(),
    );
    // 编辑器正文区被错误块替换。
    expect(document.querySelector(".editor__content")).toBeNull();

    // 「重新扫描」：调用 vaultMaintenance.rescan 并刷新知识库会话。
    await act(async () => {
      screen.getByRole("button", { name: "重新扫描知识库" }).click();
    });
    expect(rescan).toHaveBeenCalledWith(workspaceId);

    // 「返回知识库」：切回知识库首页。
    await act(async () => {
      screen.getByRole("button", { name: "返回知识库" }).click();
    });
    await waitFor(() =>
      expect(document.querySelector(".ws-home")).not.toBeNull(),
    );
  });

  it("dirty + deleted：保留编辑器内存，提供「另存副本」出口", async () => {
    const { services, emit, pageA, releaseSave } =
      await renderDirtyApp("本地保留内容");
    await act(async () => {
      emit([{ type: "deleted", vaultId: VAULT, pageId: pageA.id }]);
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "源文件已被其他程序删除，当前编辑内容仍保留在内存中。",
        ),
      ).toBeInTheDocument(),
    );
    // 编辑器内存保留，不出现错误块。
    expect(editorText()).toContain("本地保留内容");
    expect(screen.queryByText("源文件已被删除")).toBeNull();

    // 另存副本：当前内存内容成为新文档。
    await act(async () => {
      screen.getByRole("button", { name: "另存副本" }).click();
    });
    await waitFor(async () => {
      const pages = await services.page.listByWorkspace(
        (await services.workspace.list())[0].id,
      );
      const copy = pages.find((p) => p.title.endsWith("（副本）"));
      expect(copy).toBeDefined();
      expect((await services.content.get(copy!.id))?.textSnapshot).toBe(
        "本地保留内容",
      );
    });
    // 原文档正文未被污染。
    expect((await services.content.get(pageA.id))?.textSnapshot).toBe(
      "初始内容甲",
    );
    await act(async () => {
      releaseSave();
    });
  });

  it("clean + deleted 且树刷新移除该页：幽灵页保活，错误块仍可见", async () => {
    // 真实链路回归（曾存在的缺口）：emit deleted 与桥触发的
    // refreshCurrentWorkspace 同批发生，pages 镜像移除当前文档后，
    // DocumentScreen 的幽灵页须保住会话与错误块（此前落到空态）。
    const { service, emit } = makeExternalChanges();
    const rescan = vi.fn(async () => {});
    const { services } = createInMemoryAppServices();
    const { ws, pageA } = await seedWorkspace(services);
    services.externalVaultChanges = service;
    services.vaultMaintenance = { rescan };
    renderMainAreaWithBridge(services);
    await waitFor(() => expect(editorText()).toContain("初始内容甲"), {
      timeout: 5000,
    });

    await act(async () => {
      // 先发事件（桥/冲突订阅同步落地），再删仓储——桥随后的异步
      // 刷新读到删除后状态，镜像移除该页。
      emit([{ type: "deleted", vaultId: ws.id, pageId: pageA.id }]);
      await services.page.remove(pageA.id);
    });

    await waitFor(() =>
      expect(screen.getByText("源文件已被删除")).toBeInTheDocument(),
    );
    // 没有落到空态；错误块动作可用。
    expect(document.querySelector(".main-empty")).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "重新扫描知识库" }).click();
    });
    expect(rescan).toHaveBeenCalledWith(ws.id);
  });

  it("无 externalVaultChanges（Web）：不出现任何外部变更 UI", async () => {
    const { services } = createInMemoryAppServices();
    await seedWorkspace(services);
    expect(services.externalVaultChanges).toBeUndefined();
    renderMainArea(services);
    await waitFor(() => expect(editorText()).toContain("初始内容甲"), {
      timeout: 5000,
    });
    expect(
      screen.queryByText("文件已由其他程序更新，已自动重新载入。"),
    ).toBeNull();
    expect(screen.queryByText("源文件已被删除")).toBeNull();
    expect(
      screen.queryByText(
        "源文件已被其他程序删除，当前编辑内容仍保留在内存中。",
      ),
    ).toBeNull();
  });
});
