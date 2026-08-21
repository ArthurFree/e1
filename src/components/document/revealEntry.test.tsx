/**
 * R008 Stage 2（§9.4）：EditorShell「在文件管理器中显示」入口门控测试。
 * 以内存容器渲染 MainArea：
 * - capabilities.revealInFileManager=true 且装配 revealService → 顶栏出现
 *   入口，点击以当前 pageId 调 revealDocument；失败（false）经
 *   NotificationService 给出「无法定位」级别文案（不泄露路径）；
 * - capability=false（Web 形状）或无 revealService → 入口不存在
 *   （unsupported 入口不存在，而非点了报错，G4/R8-01 同原则）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { serializeRoute } from "../../domain/route";
import type { RevealService } from "../../application/services/RevealService";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";
import { AppProvider } from "../../state/AppState";
import { AppServicesProvider } from "../../state/AppServicesProvider";
import { MainArea } from "../MainArea";

function docWith(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function makeRevealService(ok = true) {
  const service: RevealService = {
    revealDocument: vi.fn(async () => ok),
    revealAsset: vi.fn(async () => ok),
  };
  return service;
}

/** 预置知识库 + 一篇文档 + 指向该文档的路由，并渲染 MainArea。 */
async function renderApp(options: {
  revealCapability: boolean;
  revealService?: RevealService;
}) {
  const { services } = createInMemoryAppServices();
  const ws = await services.workspace.create("知识库");
  const page = await services.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "文档甲",
  });
  await services.content.save(
    page.id,
    docWith("初始内容甲"),
    "初始内容甲",
    "mem:1",
  );
  await services.preferences.update({
    lastRoute: serializeRoute({
      view: "document",
      workspaceId: ws.id,
      pageId: page.id,
    }),
  });
  services.capabilities = {
    ...services.capabilities,
    revealInFileManager: options.revealCapability,
  };
  if (options.revealService) services.revealService = options.revealService;
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <MainArea />
      </AppProvider>
    </AppServicesProvider>,
  );
  await waitFor(
    () =>
      expect(
        document.querySelector(".editor__content")?.textContent ?? "",
      ).toContain("初始内容甲"),
    { timeout: 5000 },
  );
  return { services, page };
}

describe("EditorShell 在文件管理器中显示（R008 Stage 2 §9.4）", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("capability=true 且有 revealService：入口可见，点击以当前 pageId 调 revealDocument", async () => {
    const revealService = makeRevealService(true);
    const { page } = await renderApp({
      revealCapability: true,
      revealService,
    });

    const entry = screen.getByRole("button", { name: "在文件管理器中显示" });
    entry.click();
    await waitFor(() =>
      expect(revealService.revealDocument).toHaveBeenCalledWith(page.id),
    );
  });

  it("revealDocument 返回 false：经 NotificationService 提示「无法定位」（不泄露路径）", async () => {
    const revealService = makeRevealService(false);
    const { services } = await renderApp({
      revealCapability: true,
      revealService,
    });
    const notify = vi.spyOn(services.assets.notify, "notify");

    screen.getByRole("button", { name: "在文件管理器中显示" }).click();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const message = notify.mock.calls[0][0] as string;
    expect(message).toContain("无法定位");
    // 提示不得携带任何路径形态（R8-07：Renderer 不接触 absolutePath）。
    expect(message).not.toMatch(/[/\\]/);
  });

  it("capability=false（Web 形状）：入口不存在", async () => {
    await renderApp({
      revealCapability: false,
      revealService: makeRevealService(),
    });
    expect(
      screen.queryByRole("button", { name: "在文件管理器中显示" }),
    ).toBeNull();
  });

  it("capability=true 但未装配 revealService：入口不存在", async () => {
    await renderApp({ revealCapability: true });
    expect(
      screen.queryByRole("button", { name: "在文件管理器中显示" }),
    ).toBeNull();
  });
});
