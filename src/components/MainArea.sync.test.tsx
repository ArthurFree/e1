/**
 * MainArea 跨标签页同步集成测试（R004 阶段 7 §7.2/§7.3）：
 * 以内存容器 + mock BroadcastChannel 模拟另一标签页事件，验证
 * content-saved 的三种接收分支与冲突面板的四个处理选项。
 *
 * - 非当前编辑文档：增量刷新搜索索引；
 * - 当前编辑文档且本地干净：自动重载正文；
 * - 当前编辑文档且本地 dirty：显示冲突提示（与乐观锁冲突 UI 汇合），
 *   四个选项——重新载入 / 另存副本 / 强制覆盖 / 复制当前内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BroadcastChannelLike } from "../platform/web/BroadcastChangeChannel";
import { serializeRoute } from "../domain/route";
import type { Page } from "../domain/types";
import {
  createInMemoryAppServices,
  type InMemoryAppServices,
} from "../infrastructure/memory/createInMemoryAppServices";
import { AppProvider } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import { MainArea } from "./MainArea";

function docWith(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function makeMockChannel() {
  const channel: BroadcastChannelLike = {
    onmessage: null,
    postMessage: () => {},
    close: () => {},
  };
  /** 模拟另一标签页广播的事件。 */
  const emitRemote = (event: unknown) => {
    channel.onmessage?.({ data: { source: "other-tab", event } });
  };
  return { channel, emitRemote };
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

interface Fixture {
  services: InMemoryAppServices;
  emitRemote: (event: unknown) => void;
  workspaceId: string;
  pageA: Page;
  pageB: Page;
}

/** 预置知识库 + 两个文档（正文版本令牌 "mem:2"）+ 指向文档甲的路由。 */
async function seedWorkspace(services: InMemoryAppServices) {
  const ws = await services.workspace.create("知识库");
  const pageA = await services.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "文档甲",
  });
  const pageB = await services.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "文档乙",
  });
  // 初始正文：内存实现令牌 "mem:1" → "mem:2"（R005 阶段 3）。
  await services.content.save(
    pageA.id,
    docWith("初始内容甲"),
    "初始内容甲",
    "mem:1",
  );
  await services.content.save(
    pageB.id,
    docWith("初始内容乙"),
    "初始内容乙",
    "mem:1",
  );
  // 启动后直接进入文档甲的编辑视图。
  await services.preferences.update({
    lastRoute: serializeRoute({
      view: "document",
      workspaceId: ws.id,
      pageId: pageA.id,
    }),
  });
  return { ws, pageA, pageB };
}

async function renderApp(): Promise<Fixture> {
  const { channel, emitRemote } = makeMockChannel();
  const { services } = createInMemoryAppServices({ syncChannel: channel });
  const { ws, pageA, pageB } = await seedWorkspace(services);
  renderMainArea(services);
  await waitFor(() => expect(editorText()).toContain("初始内容甲"), {
    timeout: 5000,
  });
  return { services, emitRemote, workspaceId: ws.id, pageA, pageB };
}

function editorText(): string {
  return document.querySelector(".editor__content")?.textContent ?? "";
}

/**
 * 制造「本地 dirty + 远端保存」的冲突现场：
 * 渲染前注入恢复缓冲（等效本地未保存编辑），应用后首次保存被门控挂起
 * 形成 dirty 窗口；随后模拟另一标签页落盘并广播 content-saved。
 */
async function setupConflict(localText: string, remoteText: string) {
  const { channel, emitRemote } = makeMockChannel();
  const { services } = createInMemoryAppServices({ syncChannel: channel });
  const { ws, pageA, pageB } = await seedWorkspace(services);
  // 本地未保存修改：恢复缓冲比磁盘正文新，启动后出现恢复提示条。
  // R005 阶段 8：恢复缓冲经容器注入的 RecoveryStore（内存实现）写入。
  await services.recoveryStore.write({
    pageId: pageA.id,
    contentJson: docWith(localText),
    generation: 1,
    timestamp: Date.now() + 10_000,
  });
  renderMainArea(services);
  const applyButton = await screen.findByRole("button", { name: "恢复" });
  // 门控首次保存（应用恢复触发的立即保存）：制造本地 dirty 窗口。
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
  // 另一标签页此时保存了同一文档（令牌 "mem:2" → "mem:3"）并广播。
  await realSave(pageA.id, docWith(remoteText), remoteText, "mem:2");
  await act(async () => {
    emitRemote({ type: "content-saved", pageId: pageA.id, version: "mem:3" });
  });
  // dirty 分支：出现冲突提示条。
  await waitFor(() =>
    expect(document.querySelector(".conflict-banner")).not.toBeNull(),
  );
  // 放行本地保存：磁盘版本已推进 → DOCUMENT_CONFLICT，不静默覆盖。
  await act(async () => {
    release!();
  });
  await waitFor(() =>
    expect(screen.getByText("文档版本冲突")).toBeInTheDocument(),
  );
  // 磁盘仍是远端内容。
  expect((await services.content.get(pageA.id))?.textSnapshot).toBe(remoteText);
  return { services, emitRemote, workspaceId: ws.id, pageA, pageB };
}

describe("MainArea 跨标签页同步", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("非当前文档的 content-saved：增量刷新搜索索引", async () => {
    const { services, emitRemote, workspaceId, pageB } = await renderApp();
    // 另一标签页保存了文档乙（令牌 "mem:2" → "mem:3"）。
    await services.content.save(
      pageB.id,
      docWith("远端乙新词"),
      "远端乙新词",
      "mem:2",
    );
    await act(async () => {
      emitRemote({ type: "content-saved", pageId: pageB.id, version: "mem:3" });
    });
    await waitFor(async () =>
      expect(
        (await services.searchIndex.query(workspaceId, "远端乙新词")).map(
          (h) => h.pageId,
        ),
      ).toContain(pageB.id),
    );
    // 当前文档不受影响。
    expect(editorText()).toContain("初始内容甲");
  });

  it("当前文档且本地干净：自动重载远端正文", async () => {
    const { services, emitRemote, pageA } = await renderApp();
    await services.content.save(
      pageA.id,
      docWith("远端甲内容"),
      "远端甲内容",
      "mem:2",
    );
    await act(async () => {
      emitRemote({ type: "content-saved", pageId: pageA.id, version: "mem:3" });
    });
    await waitFor(() => expect(editorText()).toContain("远端甲内容"), {
      timeout: 5000,
    });
  });

  it("冲突面板③④：强制覆盖以磁盘最新版本重试成功；复制当前内容进剪贴板", async () => {
    const { services, pageA } = await setupConflict(
      "本地未保存内容",
      "远端冲突内容",
    );

    // 选项④：复制当前内容（stub 剪贴板）。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await act(async () => {
      screen.getByRole("button", { name: "复制当前内容" }).click();
    });
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("本地未保存内容"),
    );

    // 选项③：强制覆盖——读取磁盘最新 version 后以其为 expectedVersion 重试。
    await act(async () => {
      screen.getByRole("button", { name: "强制覆盖" }).click();
    });
    await waitFor(
      async () =>
        expect((await services.content.get(pageA.id))?.textSnapshot).toBe(
          "本地未保存内容",
        ),
      { timeout: 5000 },
    );
    // 远端令牌 "mem:3" → 覆盖后 "mem:4"：单调推进，无静默回退。
    expect((await services.content.get(pageA.id))?.version).toBe("mem:4");
  });

  it("冲突面板①：重新载入磁盘版本，丢弃本地未保存修改", async () => {
    const { services, pageA } = await setupConflict(
      "本地待丢弃内容",
      "远端保留内容",
    );

    await act(async () => {
      screen.getByRole("button", { name: "重新载入" }).click();
    });
    await waitFor(() => expect(editorText()).toContain("远端保留内容"), {
      timeout: 5000,
    });
    // 冲突提示条消失；编辑器内容与磁盘一致。
    await waitFor(() =>
      expect(document.querySelector(".conflict-banner")).toBeNull(),
    );
    expect((await services.content.get(pageA.id))?.textSnapshot).toBe(
      "远端保留内容",
    );
  });

  it("冲突面板②：另存副本——当前内容成为新文档并打开，原文档保持远端内容", async () => {
    const { services, pageA } = await setupConflict(
      "本地副本内容",
      "远端最终内容",
    );

    await act(async () => {
      screen.getByRole("button", { name: "另存副本" }).click();
    });
    let copy: Page | undefined;
    await waitFor(async () => {
      const pages = await services.page.listByWorkspace(
        (await services.workspace.list())[0].id,
      );
      copy = pages.find((p) => p.title.endsWith("（副本）"));
      expect(copy).toBeDefined();
    });
    // 副本正文为本地未保存内容。
    expect((await services.content.get(copy!.id))?.textSnapshot).toBe(
      "本地副本内容",
    );
    // 原文档仍是远端内容（未被本地修改污染）。
    expect((await services.content.get(pageA.id))?.textSnapshot).toBe(
      "远端最终内容",
    );
  });
});
