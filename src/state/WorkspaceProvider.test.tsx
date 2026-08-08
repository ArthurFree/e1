/**
 * WorkspaceProvider 单元测试（R004 阶段 4）：
 * - 快速连切知识库时过期会话响应被丢弃，最终状态属于最后一次请求；
 * - 删除当前文档后经导航命令桥回到知识库首页（跨域动作不复制实现）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { AppProviders } from "./AppProviders";
import { AppServicesProvider } from "./AppServicesProvider";
import { createInMemoryAppServices } from "../infrastructure/memory/createInMemoryAppServices";
import {
  useWorkspaceSession,
  type WorkspaceSessionContextValue,
} from "./WorkspaceSessionContext";
import {
  useNavigation,
  type NavigationContextValue,
} from "./NavigationContext";
import type { WorkspaceSessionData } from "../application/services/WorkspaceSessionService";
import { createDeferred } from "../test/fixtures";

let host: {
  session: WorkspaceSessionContextValue | null;
  nav: NavigationContextValue | null;
};

function Probe() {
  host.session = useWorkspaceSession();
  host.nav = useNavigation();
  return null;
}

async function renderWithMemory() {
  const { services, store } = createInMemoryAppServices();
  const wsA = await services.workspace.create("甲库");
  const wsB = await services.workspace.create("乙库");
  const pageA = await services.page.create({
    workspaceId: wsA.id,
    parentId: null,
    kind: "document",
    title: "甲页",
  });
  const pageB = await services.page.create({
    workspaceId: wsB.id,
    parentId: null,
    kind: "document",
    title: "乙页",
  });
  const utils = render(
    <AppServicesProvider services={services}>
      <AppProviders>
        <Probe />
      </AppProviders>
    </AppServicesProvider>,
  );
  return { services, store, wsA, wsB, pageA, pageB, ...utils };
}

function sessionDataOf(
  workspaceId: string,
  pages: WorkspaceSessionData["pages"],
): WorkspaceSessionData {
  return { workspaceId, pages, tags: [], pageTags: [] };
}

describe("WorkspaceProvider", () => {
  beforeEach(() => {
    cleanup();
    host = { session: null, nav: null };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("快速连切知识库时过期会话响应被丢弃", async () => {
    const { services, wsA, wsB, pageA, pageB } = await renderWithMemory();
    await waitFor(() => expect(host.session?.ready).toBe(true), {
      timeout: 3000,
    });

    // 初始加载完成后接管会话加载，人为制造乱序响应。
    const deferredA = createDeferred<WorkspaceSessionData>();
    const deferredB = createDeferred<WorkspaceSessionData>();
    vi.spyOn(services.session, "load").mockImplementation((id: string) =>
      id === wsA.id ? deferredA.promise : deferredB.promise,
    );

    // 连切 A → B：B 是最后一次请求，A 的响应必然过期。
    void host.session!.switchWorkspace(wsA.id);
    void host.session!.switchWorkspace(wsB.id);

    // B 先到达：生效并进入乙库。
    await act(async () => {
      deferredB.resolve(sessionDataOf(wsB.id, [pageB]));
    });
    await waitFor(() => expect(host.session?.workspace?.id).toBe(wsB.id));
    expect(host.session?.pages.map((p) => p.title)).toEqual(["乙页"]);

    // A 的过期响应后到达：必须被丢弃，会话停留在乙库。
    await act(async () => {
      deferredA.resolve(sessionDataOf(wsA.id, [pageA]));
    });
    expect(host.session?.workspace?.id).toBe(wsB.id);
    expect(host.session?.pages.map((p) => p.title)).toEqual(["乙页"]);
  });

  it("删除当前文档后经命令桥回到知识库首页", async () => {
    await renderWithMemory();
    await waitFor(() => expect(host.session?.ready).toBe(true), {
      timeout: 3000,
    });

    await act(async () => {
      await host.session!.createPage("document", null);
    });
    expect(host.nav?.view).toBe("document");
    const openedId = host.nav!.selectedPageId;
    expect(openedId).not.toBeNull();

    await act(async () => {
      await host.session!.deletePage(openedId!);
    });
    expect(host.nav?.view).toBe("workspace");
    expect(host.nav?.selectedPageId).toBeNull();
  });
});
