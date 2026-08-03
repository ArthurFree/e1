/**
 * Context 渲染粒度测试（R004 §4.6 验收）：
 * - 会话数据变化（renamePage）只触发 useWorkspaceData 消费者重渲染，
 *   useWorkspaceCommands 消费者不动，且命令回调引用跨数据变化稳定；
 * - 导航状态变化（showRecent）只触发 useNavigationState 消费者重渲染，
 *   useNavigationCommands 消费者不动，且命令回调引用跨路由变化稳定。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { TestApp } from "../test/TestApp";
import { createRenderProbe, type RenderProbe } from "../test/renderProbe";
import { resetDB } from "../infrastructure/db";
import {
  pageRepository,
  workspaceRepository,
} from "../infrastructure/repositories";
import { useApp } from "./AppState";
import {
  useWorkspaceCommands,
  useWorkspaceData,
  type WorkspaceCommandContextValue,
} from "./WorkspaceSessionContext";
import {
  useNavigationCommands,
  useNavigationState,
  type NavigationCommandContextValue,
} from "./NavigationContext";

let host: { app: ReturnType<typeof useApp> | null };
let wsDataProbe: RenderProbe;
let wsCmdProbe: RenderProbe;
let navStateProbe: RenderProbe;
let navCmdProbe: RenderProbe;
// 命令 Context 每次渲染下发的 value 引用：全程应只有一份。
let capturedWsCommandValues: WorkspaceCommandContextValue[];
let capturedNavCommandValues: NavigationCommandContextValue[];

function WsDataConsumer() {
  useWorkspaceData();
  wsDataProbe.Probe();
  return null;
}

function WsCommandConsumer() {
  capturedWsCommandValues.push(useWorkspaceCommands());
  wsCmdProbe.Probe();
  return null;
}

function NavStateConsumer() {
  useNavigationState();
  navStateProbe.Probe();
  return null;
}

function NavCommandConsumer() {
  capturedNavCommandValues.push(useNavigationCommands());
  navCmdProbe.Probe();
  return null;
}

function Control() {
  host.app = useApp();
  return null;
}

describe("Context 渲染粒度（R004 §4.6）", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { app: null };
    wsDataProbe = createRenderProbe();
    wsCmdProbe = createRenderProbe();
    navStateProbe = createRenderProbe();
    navCmdProbe = createRenderProbe();
    capturedWsCommandValues = [];
    capturedNavCommandValues = [];
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "粒度测试文档",
    });
    render(
      <TestApp>
        <Control />
        <WsDataConsumer />
        <WsCommandConsumer />
        <NavStateConsumer />
        <NavCommandConsumer />
      </TestApp>,
    );
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });
  });

  it("renamePage 只触发会话数据消费者重渲染，命令消费者不动且引用稳定", async () => {
    const pageId = host.app!.pages.find((p) => p.title === "粒度测试文档")!.id;
    const dataBefore = wsDataProbe.count.current;
    const cmdBefore = wsCmdProbe.count.current;
    const navCmdBefore = navCmdProbe.count.current;
    const renameRef = host.app!.renamePage;

    await host.app!.renamePage(pageId, "粒度改名");
    await waitFor(() =>
      expect(host.app!.pages.find((p) => p.id === pageId)?.title).toBe(
        "粒度改名",
      ),
    );

    // 数据消费者随 pages 变化重渲染；命令消费者（会话与导航）不动。
    expect(wsDataProbe.count.current).toBeGreaterThan(dataBefore);
    expect(wsCmdProbe.count.current).toBe(cmdBefore);
    expect(navCmdProbe.count.current).toBe(navCmdBefore);
    // 命令回调引用跨数据变化稳定（经 useApp 聚合读取的也是同一引用）。
    expect(host.app!.renamePage).toBe(renameRef);
    // 命令 Context value 全程只有一份引用。
    expect(new Set(capturedWsCommandValues).size).toBe(1);
  });

  it("视图切换只触发导航状态消费者重渲染，命令消费者不动且引用稳定", async () => {
    const stateBefore = navStateProbe.count.current;
    const navCmdBefore = navCmdProbe.count.current;
    const wsCmdBefore = wsCmdProbe.count.current;
    const openRef = host.app!.openDocument;

    host.app!.showRecent();
    await waitFor(() => expect(host.app!.view).toBe("recent"));

    // 状态消费者随 view 变化重渲染；命令消费者（导航与会话）不动。
    expect(navStateProbe.count.current).toBeGreaterThan(stateBefore);
    expect(navCmdProbe.count.current).toBe(navCmdBefore);
    expect(wsCmdProbe.count.current).toBe(wsCmdBefore);
    // 命令回调引用跨路由变化稳定。
    expect(host.app!.openDocument).toBe(openRef);
    expect(new Set(capturedNavCommandValues).size).toBe(1);
  });
});
