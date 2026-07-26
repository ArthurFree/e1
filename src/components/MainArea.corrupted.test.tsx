/**
 * MainArea 损坏正文 UI 测试（R003 阶段 4）：
 * 正文 JSON 校验失败时不渲染编辑器，显示损坏处理面板；
 * 「尝试恢复」以 sanitize 结果重建编辑器并落盘；
 * 「创建空白副本」覆盖为合法空文档并清除诊断记录。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  workspaceRepository,
} from "../infrastructure/repositories";
import { serializeRoute } from "../domain/route";
import { parseDocumentContent } from "../domain/validation/documentContent";
import { readCorruptedDiagnostic } from "../application/services/corruptedDiagnostics";
import { MainArea } from "./MainArea";

const CORRUPTED_JSON = {
  type: "doc",
  content: [
    { type: "evilNode" },
    { type: "paragraph", content: [{ type: "text", text: "保留文本" }] },
  ],
};

async function renderWithCorruptedDoc() {
  const [ws] = await workspaceRepository.list();
  const page = await pageRepository.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "损坏文档",
  });
  await contentRepository.save(page.id, CORRUPTED_JSON, "坏文本");
  // 通过持久化路由让 AppProvider 启动后直接打开该文档。
  await preferencesRepository.update({
    lastRoute: serializeRoute({
      view: "document",
      workspaceId: ws.id,
      pageId: page.id,
    }),
  });
  render(
    <TestApp>
      <MainArea onOpenTree={() => undefined} />
    </TestApp>,
  );
  return page;
}

describe("MainArea 损坏正文面板", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    localStorage.clear();
  });

  it("校验失败不渲染编辑器，显示面板并写诊断记录", async () => {
    const page = await renderWithCorruptedDoc();
    expect(await screen.findByText("文档内容损坏")).toBeInTheDocument();
    expect(document.querySelector(".editor__content")).toBeNull();
    expect(screen.getByText("尝试恢复")).toBeInTheDocument();
    expect(screen.getByText("导出原始 JSON")).toBeInTheDocument();
    expect(screen.getByText("创建空白副本")).toBeInTheDocument();
    await waitFor(() =>
      expect(readCorruptedDiagnostic(page.id)).not.toBeNull(),
    );
  });

  it("尝试恢复：sanitize 结果进入编辑器并落盘", async () => {
    const page = await renderWithCorruptedDoc();
    fireEvent.click(await screen.findByText("尝试恢复"));

    // sanitize 保留合法段落，剔除非法节点。
    expect(await screen.findByText("保留文本")).toBeInTheDocument();
    // 恢复后触发一次立即保存，落盘内容通过严格校验。
    await waitFor(
      async () => {
        const saved = await contentRepository.get(page.id);
        expect(parseDocumentContent(saved?.contentJson).ok).toBe(true);
        expect(saved?.textSnapshot).toContain("保留文本");
      },
      { timeout: 4000 },
    );
  }, 15000);

  it("创建空白副本：覆盖为合法空文档并清除诊断记录", async () => {
    const page = await renderWithCorruptedDoc();
    await waitFor(() =>
      expect(readCorruptedDiagnostic(page.id)).not.toBeNull(),
    );
    fireEvent.click(await screen.findByText("创建空白副本"));

    await waitFor(
      async () => {
        const saved = await contentRepository.get(page.id);
        expect(parseDocumentContent(saved?.contentJson).ok).toBe(true);
        expect(saved?.textSnapshot ?? "").not.toContain("坏文本");
      },
      { timeout: 4000 },
    );
    expect(readCorruptedDiagnostic(page.id)).toBeNull();
    // 空白副本可正常进入编辑器。
    await waitFor(() =>
      expect(document.querySelector(".editor__content")).not.toBeNull(),
    );
  }, 15000);
});
