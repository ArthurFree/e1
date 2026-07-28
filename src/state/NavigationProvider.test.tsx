/**
 * NavigationProvider 单元测试（R004 阶段 4）：
 * 跨知识库打开文档经工作区内部通道原子切换会话——导航域不自行
 * 复制会话加载逻辑，切换成功前不进入文档视图。
 */
import { beforeEach, describe, expect, it } from "vitest";
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

let host: {
  session: WorkspaceSessionContextValue | null;
  nav: NavigationContextValue | null;
};

function Probe() {
  host.session = useWorkspaceSession();
  host.nav = useNavigation();
  return null;
}

describe("NavigationProvider", () => {
  beforeEach(() => {
    cleanup();
    host = { session: null, nav: null };
  });

  it("跨知识库打开文档：原子切换会话并进入文档视图", async () => {
    const { services } = createInMemoryAppServices();
    const wsA = await services.workspace.create("甲库");
    const wsB = await services.workspace.create("乙库");
    render(
      <AppServicesProvider services={services}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </AppServicesProvider>,
    );
    await waitFor(() => expect(host.session?.ready).toBe(true), {
      timeout: 3000,
    });

    // 目标文档放在「非当前」知识库中（初始选中的库由列表顺序决定）。
    const currentId = host.session!.workspace!.id;
    const other = currentId === wsA.id ? wsB : wsA;
    const target = await services.page.create({
      workspaceId: other.id,
      parentId: null,
      kind: "document",
      title: "他库文档",
    });

    await act(async () => {
      await host.nav!.openDocument(target.id);
    });

    // 会话已原子切换到目标库，导航进入文档视图。
    expect(host.session?.workspace?.id).toBe(other.id);
    expect(host.session?.pages.some((p) => p.id === target.id)).toBe(true);
    expect(host.nav?.view).toBe("document");
    expect(host.nav?.selectedPageId).toBe(target.id);
  });

  it("定位文档：切换所属知识库但主区域停在知识库首页", async () => {
    const { services } = createInMemoryAppServices();
    const wsA = await services.workspace.create("甲库");
    const wsB = await services.workspace.create("乙库");
    render(
      <AppServicesProvider services={services}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </AppServicesProvider>,
    );
    await waitFor(() => expect(host.session?.ready).toBe(true), {
      timeout: 3000,
    });

    const currentId = host.session!.workspace!.id;
    const other = currentId === wsA.id ? wsB : wsA;
    const target = await services.page.create({
      workspaceId: other.id,
      parentId: null,
      kind: "document",
      title: "他库文档",
    });

    await act(async () => {
      await host.nav!.locatePage(target.id);
    });

    expect(host.session?.workspace?.id).toBe(other.id);
    expect(host.nav?.view).toBe("workspace");
    expect(host.nav?.selectedPageId).toBe(target.id);
  });
});
