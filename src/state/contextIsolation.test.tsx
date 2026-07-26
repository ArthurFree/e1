/**
 * Context 渲染隔离测试（R003 阶段 6 验收）：
 * - setTheme 只触发偏好域消费者重渲染（页面树等会话消费者不动）；
 * - renamePage 只触发会话域消费者重渲染（设置等偏好/浮层消费者不动）；
 * - openSettings 只触发浮层域消费者重渲染。
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
import { useWorkspaceSession } from "./WorkspaceSessionContext";
import { usePreferences } from "./PreferencesContext";
import { useOverlay } from "./OverlayContext";

let host: { app: ReturnType<typeof useApp> | null };
let sessionProbe: RenderProbe;
let prefsProbe: RenderProbe;
let overlayProbe: RenderProbe;

function SessionConsumer() {
  useWorkspaceSession();
  sessionProbe.Probe();
  return null;
}

function PrefsConsumer() {
  usePreferences();
  prefsProbe.Probe();
  return null;
}

function OverlayConsumer() {
  useOverlay();
  overlayProbe.Probe();
  return null;
}

function Control() {
  host.app = useApp();
  return null;
}

describe("Context 渲染隔离", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { app: null };
    sessionProbe = createRenderProbe();
    prefsProbe = createRenderProbe();
    overlayProbe = createRenderProbe();
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "隔离测试文档",
    });
    render(
      <TestApp>
        <Control />
        <SessionConsumer />
        <PrefsConsumer />
        <OverlayConsumer />
      </TestApp>,
    );
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });
  });

  it("setTheme 只触发偏好域消费者重渲染", async () => {
    const sessionBefore = sessionProbe.count.current;
    const overlayBefore = overlayProbe.count.current;
    const prefsBefore = prefsProbe.count.current;

    await host.app!.setTheme("dark");
    await waitFor(() => expect(host.app!.preferences.theme).toBe("dark"));

    expect(prefsProbe.count.current).toBeGreaterThan(prefsBefore);
    expect(sessionProbe.count.current).toBe(sessionBefore);
    expect(overlayProbe.count.current).toBe(overlayBefore);
  });

  it("renamePage 只触发会话域消费者重渲染", async () => {
    const pageId = host.app!.pages.find((p) => p.title === "隔离测试文档")!.id;
    const sessionBefore = sessionProbe.count.current;
    const overlayBefore = overlayProbe.count.current;
    const prefsBefore = prefsProbe.count.current;

    await host.app!.renamePage(pageId, "改名后");
    await waitFor(() =>
      expect(host.app!.pages.find((p) => p.id === pageId)?.title).toBe("改名后"),
    );

    expect(sessionProbe.count.current).toBeGreaterThan(sessionBefore);
    expect(prefsProbe.count.current).toBe(prefsBefore);
    expect(overlayProbe.count.current).toBe(overlayBefore);
  });

  it("openSettings 只触发浮层域消费者重渲染", async () => {
    const sessionBefore = sessionProbe.count.current;
    const overlayBefore = overlayProbe.count.current;
    const prefsBefore = prefsProbe.count.current;

    host.app!.openSettings();
    await waitFor(() => expect(host.app!.settingsOpen).toBe(true));

    expect(overlayProbe.count.current).toBeGreaterThan(overlayBefore);
    expect(sessionProbe.count.current).toBe(sessionBefore);
    expect(prefsProbe.count.current).toBe(prefsBefore);
  });
});
