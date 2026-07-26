/**
 * 保存并发回归测试（R003 阶段 0 基线，阶段 1 SaveCoordinator 的验收标准）：
 *
 * 1. 保存 A 未完成时触发保存 B 且 A 比 B 更晚完成：旧保存不得覆盖新内容；
 * 2. 旧保存完成时仍有未保存内容：UI 不得误报「已保存」。
 *
 * contentRepository.save 被替换为「deferred 门控 + 真实落库」：resolve 顺序
 * 即落库顺序，由测试精确编排乱序完成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { AppProvider, useApp } from "../../state/AppState";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { createDeferred, sleep, type Deferred } from "../../test/fixtures";
import { DocumentEditor, type SaveState } from "./DocumentEditor";

let host: {
  editor: Editor | null;
  pageId: string | null;
  states: SaveState[];
};

function Harness() {
  const { ready, workspace, pages } = useApp();
  host.pageId = pages.find((p) => p.kind === "document")?.id ?? null;
  if (!ready || !host.pageId || !workspace) return null;
  return (
    <DocumentEditor
      pageId={host.pageId}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      onEditorReady={(editor) => {
        host.editor = editor;
      }}
      onSaveStateChange={(state) => {
        host.states.push(state);
      }}
    />
  );
}

function lastStatus() {
  return host.states[host.states.length - 1]?.status;
}

describe("DocumentEditor 并发保存", () => {
  let saveCalls: Deferred<void>[];

  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, pageId: null, states: [] };
    saveCalls = [];
    const [ws] = await workspaceRepository.list();
    await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "并发文档",
    });
    // 门控保存：调用即挂起，测试 resolve 后才真正写库，模拟乱序完成。
    const realSave = contentRepository.save.bind(contentRepository);
    vi.spyOn(contentRepository, "save").mockImplementation(
      (pageId, json, text) => {
        const gate = createDeferred<void>();
        saveCalls.push(gate);
        return gate.promise.then(() => realSave(pageId, json, text));
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("后发起的保存先完成时，旧保存不得覆盖新内容", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;
    const pageId = host.pageId!;

    editor.commands.insertContent("第一段内容");
    await waitFor(() => expect(saveCalls.length).toBe(1), { timeout: 4000 });

    // 保存 A 仍在途，继续编辑触发保存 B（800ms 防抖后提交）。
    editor.commands.insertContent("第二段内容");
    await sleep(1500);

    // 乱序完成：B 先、A 后。串行实现中 B 在 A 完成后才发起，以下编排两种时序均适用。
    saveCalls[1]?.resolve();
    saveCalls[0].resolve();
    await waitFor(() => expect(saveCalls.length).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
    });
    saveCalls[1].resolve();

    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });
    const saved = await contentRepository.get(pageId);
    expect(saved?.textSnapshot).toContain("第二段内容");
  }, 15000);

  it("旧保存完成时仍有未保存内容，不得显示已保存", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await waitFor(() => expect(host.editor).not.toBeNull(), { timeout: 3000 });
    const editor = host.editor!;

    editor.commands.insertContent("第一段内容");
    await waitFor(() => expect(saveCalls.length).toBe(1), { timeout: 4000 });

    // 新编辑刚发生（dirty），其防抖尚未触发第二次保存时，旧保存完成。
    editor.commands.insertContent("未落盘内容");
    saveCalls[0].resolve();
    await sleep(200);
    expect(lastStatus()).not.toBe("saved");

    // 收尾：放行第二次保存，避免遗留挂起写入影响其他用例。
    await waitFor(() => expect(saveCalls.length).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
    });
    saveCalls[1].resolve();
    await waitFor(() => expect(lastStatus()).toBe("saved"), { timeout: 4000 });
  }, 15000);
});
