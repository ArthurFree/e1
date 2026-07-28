/**
 * 文档切换保存回归测试（R003 阶段 0 基线）：
 * 切换文档时仍有未执行的防抖保存，挂起编辑必须落盘到「旧」文档，
 * 且不得写入「新」文档。
 *
 * 当前实现的缺陷：pageId 变化后 flush() 执行的是新闭包（新 pageId），
 * 旧文档的挂起快照会被写入新文档。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useApp } from "../../state/AppState";
import { TestApp } from "../../test/TestApp";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { DocumentEditor } from "./DocumentEditor";

/** beforeEach 中创建的两个测试文档 ID（种子数据另有预置文档，需显式区分）。 */
let docIds: string[] = [];

let host: {
  editor: Editor | null;
  current: string | null;
  switchTo: ((id: string) => void) | null;
};

function Harness() {
  const { ready, workspace } = useApp();
  const [current, setCurrent] = useState<string | null>(null);
  const pageId = current ?? docIds[0] ?? null;
  host.current = pageId;
  host.switchTo = setCurrent;
  if (!ready || !pageId || !workspace) return null;
  return (
    <DocumentEditor
      pageId={pageId}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialVersion={1}
      onEditorReady={(editor) => {
        host.editor = editor;
      }}
    />
  );
}

describe("DocumentEditor 文档切换时的挂起保存", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { editor: null, current: null, switchTo: null };
    const [ws] = await workspaceRepository.list();
    const doc1 = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "甲文档",
    });
    const doc2 = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "乙文档",
    });
    docIds = [doc1.id, doc2.id];
  });

  it("挂起编辑落盘到旧文档，不写入新文档", async () => {
    render(
      <TestApp>
        <Harness />
      </TestApp>,
    );
    await waitFor(
      () => {
        expect(host.editor).not.toBeNull();
        expect(host.current).toBe(docIds[0]);
      },
      { timeout: 3000 },
    );
    const [doc1, doc2] = docIds;

    // 800ms 防抖窗口内立即切换文档：旧编辑仍处于挂起状态。
    host.editor!.commands.insertContent("甲文档独有内容");
    host.switchTo!(doc2);

    // 旧文档必须最终收到挂起编辑（切换触发的强制落盘）。
    await waitFor(
      async () => {
        const saved = await contentRepository.get(doc1);
        expect(saved?.textSnapshot ?? "").toContain("甲文档独有内容");
      },
      { timeout: 4000 },
    );

    // 新文档不得被旧快照污染。
    const leaked = await contentRepository.get(doc2);
    expect(leaked?.textSnapshot ?? "").not.toContain("甲文档独有内容");
  }, 15000);
});
