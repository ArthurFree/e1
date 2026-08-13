/**
 * 工作区切换竞态回归测试（R003 阶段 0 基线，阶段 2 会话原子化的验收标准）：
 * 快速连续切换两个知识库时，只有最后一次请求生效；
 * 页面、标签、页面-标签关联必须始终属于同一个知识库。
 *
 * 当前实现的缺陷：switchWorkspace 先 setWorkspaceId 再异步加载，
 * 旧知识库的过期响应到达时会覆盖新知识库的数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useApp } from "./AppState";
import { resetDB } from "../platform/web/persistence/db";
import { TestApp } from "../test/TestApp";
import {
  pageRepository,
  tagRepository,
  workspaceRepository,
} from "../platform/web/persistence/repositories";
import { createDeferred, sleep } from "../test/fixtures";

let host: { app: ReturnType<typeof useApp> | null };

function Probe() {
  host.app = useApp();
  return null;
}

describe("工作区切换竞态", () => {
  let ws1Id: string;
  let ws2Id: string;

  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { app: null };
    const [ws1] = await workspaceRepository.list();
    ws1Id = ws1.id;
    const ws2 = await workspaceRepository.create("乙知识库");
    ws2Id = ws2.id;
    await pageRepository.create({
      workspaceId: ws1Id,
      parentId: null,
      kind: "document",
      title: "甲库页面",
    });
    await tagRepository.create(ws1Id, "甲库标签", "#111111");
    await pageRepository.create({
      workspaceId: ws2Id,
      parentId: null,
      kind: "document",
      title: "乙库页面",
    });
    await tagRepository.create(ws2Id, "乙库标签", "#222222");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("快速连切时只有最后一次切换生效", async () => {
    render(
      <TestApp>
        <Probe />
      </TestApp>,
    );
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });

    // 让甲库（先发起）的页面加载挂起：其响应必然晚于乙库到达。
    const gate = createDeferred<void>();
    const realList = pageRepository.listByWorkspace.bind(pageRepository);
    vi.spyOn(pageRepository, "listByWorkspace").mockImplementation((id) =>
      id === ws1Id ? gate.promise.then(() => realList(id)) : realList(id),
    );

    void host.app!.switchWorkspace(ws1Id);
    void host.app!.switchWorkspace(ws2Id);

    // 乙库（后发起）先加载完成。
    await waitFor(
      () => {
        expect(host.app!.pages.some((p) => p.title === "乙库页面")).toBe(true);
      },
      { timeout: 3000 },
    );
    // 甲库的过期响应随后到达，必须被丢弃。
    gate.resolve();
    await sleep(500);

    expect(host.app!.workspace?.id).toBe(ws2Id);
    expect(host.app!.pages.some((p) => p.title === "乙库页面")).toBe(true);
    expect(host.app!.pages.every((p) => p.workspaceId === ws2Id)).toBe(true);
    expect(host.app!.tags.every((t) => t.workspaceId === ws2Id)).toBe(true);
    const pageIds = new Set(host.app!.pages.map((p) => p.id));
    expect(host.app!.pageTags.every((pt) => pageIds.has(pt.pageId))).toBe(true);
  }, 15000);
});
